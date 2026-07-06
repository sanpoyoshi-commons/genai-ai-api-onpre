import { Router } from 'express';
import { resolveEnabledUseCases } from '../lib/config/enabledUseCases.js';
import { logger } from '../lib/logger.js';
import { requireUseCase } from '../middleware/requireUseCase.js';
import { PostgresApiKeyStore } from '../lib/apikey/postgresApiKeyStore.js';
import { SdcppImageClient } from '../lib/image/sdcppImageClient.js';
import { KeycloakIdpClient } from '../lib/idp/keycloakIdpClient.js';
import { EmbeddingAbstractionClient } from '../lib/llm/embeddingAbstractionClient.js';
import { LlmAbstractionClient } from '../lib/llm/llmAbstractionClient.js';
import { RerankAbstractionClient } from '../lib/llm/rerankAbstractionClient.js';
import { loadRagConfig } from '../lib/rag/config.js';
import { RagService } from '../lib/rag/ragService.js';
import { ArticleSelector } from '../lib/lawRag/articleSelector.js';
import { LawNameEstimator } from '../lib/lawRag/lawNameEstimator.js';
import { LawReportPipeline } from '../lib/lawRag/lawReportPipeline.js';
import { ReportGenerator } from '../lib/lawRag/reportGenerator.js';
import { LawRetriever } from '../repositories/lawRetriever.js';
import { loadQueueConfig } from '../lib/queue/config.js';
import { ExAppQueue } from '../lib/queue/exAppQueue.js';
import { createSqsClient } from '../lib/queue/sqsClient.js';
import { loadCodeInterpreterConfig } from '../lib/sandbox/config.js';
import { HttpSandboxClient } from '../lib/sandbox/httpSandboxClient.js';
import { loadStorageBuckets } from '../lib/storage/config.js';
import { SeaweedFsStorage } from '../lib/storage/seaweedFsStorage.js';
import { DbTranscriptionClient } from '../lib/transcription/dbTranscriptionClient.js';
import { ChatRepository } from '../repositories/chatRepository.js';
import { ExAppRepository } from '../repositories/exAppRepository.js';
import { RagRepository } from '../repositories/ragRepository.js';
import { InvokeHistoryRepository } from '../repositories/invokeHistoryRepository.js';
import { MessageRepository } from '../repositories/messageRepository.js';
import { SystemContextRepository } from '../repositories/systemContextRepository.js';
import { TeamRepository } from '../repositories/teamRepository.js';
import { TeamUserRepository } from '../repositories/teamUserRepository.js';
import { createChatsRouter } from './chats/index.js';
import { createCodeInterpreterRouter } from './codeInterpreter/index.js';
import { createExAppsRouter } from './exApps/index.js';
import { createFilesRouter } from './files/index.js';
import { createImageRouter } from './image/index.js';
import { createInvokeHistoriesRouter } from './invokeHistories/index.js';
import { createPredictRouter } from './predict/index.js';
import { createLawRagRouter } from './lawRag/index.js';
import { createRagRouter } from './rag/index.js';
import { createSystemContextsRouter } from './systemContexts/index.js';
import { createTeamsRouter } from './teams/index.js';
import { createTeamUsersRouter } from './teamUsers/index.js';
import { createTranscribeRouter } from './transcribe/index.js';

/**
 * /api 配下のリソース群 Router（requireAuth ゲートの内側にマウントされる、app.ts）。
 *
 * 全リソース群（chats/systemcontexts/predict/rag/image/files/transcribe/teams/teamUsers/exApps/
 * invokeHistories）を配線する。env から実依存を構築する。リポジトリは既定で getPrisma()（lazy）を使い、
 * DATABASE_URL は初回利用時に要求される。外部バックエンド（IdP/apiKey/LLM/画像/ストレージ/文字起こし）は seam
 * （Deferred* skeleton）で配線し、実バックエンドは後続で差し替える。
 */
export function createApiRouterFromEnv(): Router {
  const config = loadQueueConfig();
  const sqs = createSqsClient(config);
  const queue = new ExAppQueue(sqs, config.queueUrl);
  const transcribeQueue = new ExAppQueue(sqs, config.transcribeQueueUrl);

  // リソース群が共有する実依存（リポジトリ）。
  const teams = new TeamRepository();
  const teamUsers = new TeamUserRepository();
  const exApps = new ExAppRepository();
  // inputs 退避：巨大 inputs（base64 ファイル等）は artifacts バケットへ退避し DB 行を小さく保つ（読取時に透過復元）。
  const histories = new InvokeHistoryRepository(undefined, new SeaweedFsStorage(), process.env.ARTIFACTS_BUCKET_NAME);
  const chats = new ChatRepository();

  // 外部バックエンド。idp（Keycloak Admin REST）/ apiKey（ex_app_api_keys テーブル・任意 AES-GCM）/
  // llm（抽象化レイヤー）/ storage（SeaweedFS・S3 互換）/ image（stable-diffusion.cpp）/
  // 文字起こし（DB ジョブ＋専用ワーカー＋faster-whisper）は実配線済。文字起こしの本体（Whisper 呼び出し）は
  // worker に閉じ、api 側クライアントは状態ストアの起票（QUEUED）と読み出しだけを担う。
  const idp = new KeycloakIdpClient();
  const apiKeys = new PostgresApiKeyStore();
  const llm = new LlmAbstractionClient();
  // RAG。embedding は TEI/ruri（EmbeddingClient seam）、検索は
  // pgvector + pg_bigm + RRF（RagRepository raw SQL）、回答生成は上の llm を流用（retrieve-and-generate）。
  // rerank は TEI ネイティブ /rerank（RerankClient seam）。常に注入し、有効化は
  // RERANK_ENABLED（loadRagConfig が読む・既定 false）でゲート。無効/未起動/失敗時は RRF 順にフォールバック。
  const rag = new RagService({
    embedding: new EmbeddingAbstractionClient(),
    repo: new RagRepository(),
    config: loadRagConfig(),
    rerank: new RerankAbstractionClient(),
  });
  // 法令 RAG（lawsy 忠実ポート）。法令名ベース 4 段階：embedding は TEI/ruri で
  // law_title_embedding 近傍検索（LawRetriever）、法令名推定・条文選別・レポート生成は上の llm を流用。
  // 一般文書 RAG と同じ 'rag'（embedding profile）ゲートで点灯。
  const lawReportPipeline = new LawReportPipeline({
    estimator: new LawNameEstimator(llm),
    selector: new ArticleSelector(llm),
    generator: new ReportGenerator(llm),
    retriever: new LawRetriever(new EmbeddingAbstractionClient()),
  });
  const image = new SdcppImageClient();
  // Code Interpreter。コード生成は上の llm を流用、実行は NsJail サンドボックス（SandboxClient seam・
  // profile sandbox）へ委譲。SANDBOX_BASE_URL は使用時にのみ要求（未配線でも起動可）。
  const sandbox = new HttpSandboxClient();
  const codeInterpreterConfig = loadCodeInterpreterConfig();
  const storage = new SeaweedFsStorage();
  const transcription = new DbTranscriptionClient({ queue: transcribeQueue });
  const buckets = loadStorageBuckets();

  const router = Router();

  // 機能 ON/OFF ガード（compose profile 連動）。off の機能は経路ごと 503 を返し、
  // web のメニュー非表示（isUseCaseEnabled）と整合させる。COMPOSE_PROFILES／ENABLED_USE_CASES から解決
  // （nginx entrypoint と同仕様）。chat/predict・chats・history・teams 等の常時機能はガードしない。
  // 各リソース router より前に path 単位で前置する（Express はミドルウェア登録順で評価）。
  const enabledUseCases = resolveEnabledUseCases();
  // Code Interpreter（任意コード実行）が有効な構成では、api 起動時にも「改めて警告」する。
  // sandbox コンテナ側の ack ゲート（entrypoint.sh）に届かない、api ログだけ見る開発者向けの第二の導線。
  // 既定 off のため通常構成では出ない（docs/sandbox-acceptance-decision.md §7）。
  if (enabledUseCases.codeInterpreter) {
    logger.warn(
      { useCase: 'codeInterpreter', posture: 'seccomp=unconfined+4cap' },
      'Code Interpreter 有効: 任意コードを NsJail サンドボックスで実行します（localhost/opt-in/無保証 前提）。残存リスクと受容判断: docs/sandbox-acceptance-decision.md',
    );
  }
  router.use('/rag', requireUseCase(enabledUseCases, 'rag'));
  router.use('/law-rag', requireUseCase(enabledUseCases, 'rag'));
  router.use('/image', requireUseCase(enabledUseCases, 'image'));
  router.use('/transcribe', requireUseCase(enabledUseCases, 'transcribe'));
  // ExApp の非同期実行のみゲート（queue profile 依存）。一覧 GET /exapps・作成 POST /teams/:id/exapps は
  // queue 不要のため常時許可（閲覧・追加は既定でも可）。
  router.use('/exapps/invoke', requireUseCase(enabledUseCases, 'apps'));
  // Code Interpreter（任意コード実行・sandbox profile 依存）。off なら 503。
  router.use('/code-interpreter', requireUseCase(enabledUseCases, 'codeInterpreter'));

  // chats リソース群（本人スコープ）。
  router.use(createChatsRouter({ chats, messages: new MessageRepository() }));

  // systemcontexts リソース群（本人スコープ）。
  router.use(createSystemContextsRouter({ systemContexts: new SystemContextRepository() }));

  // predict リソース群（predictStream 含む、LLM seam）。
  router.use(createPredictRouter({ llm, chats }));

  // rag リソース群（-onpre 新規、ハイブリッド検索＋retrieve-and-generate）。
  router.use(createRagRouter({ rag, llm }));

  // lawRag リソース群（法令名ベース忠実ポート＝推定→特定→選別→レポート→出典結合）。
  router.use(createLawRagRouter({ pipeline: lawReportPipeline }));

  // codeInterpreter リソース群（源内独自 IF・CSV/Excel→pandas→matplotlib を NsJail サンドボックスで実行）。
  router.use(createCodeInterpreterRouter({ llm, sandbox, config: codeInterpreterConfig }));

  // image リソース群（画像生成 seam）。
  router.use(createImageRouter({ image }));

  // file リソース群（FileStorage seam・所有権 userId）。
  router.use(createFilesRouter({ storage, buckets }));

  // transcribe リソース群（文字起こし seam・/transcribe/url はアップロード署名流用）。
  router.use(createTranscribeRouter({ transcription, storage, buckets }));

  // teams リソース群（認可2層＋共通チーム特例）。
  router.use(createTeamsRouter({ teams, teamUsers, exApps, histories, idp, apiKeys }));

  // teamUsers リソース群（最後の管理者保護）。
  router.use(createTeamUsersRouter({ teams, teamUsers, idp }));

  // exApps リソース群（listExApps／invokeExApp）。
  router.use(createExAppsRouter({ queue, teams, teamUsers, exApps, histories }));

  // invokeHistories リソース群（履歴参照系＋アーティファクト署名 URL）。
  router.use(createInvokeHistoriesRouter({ teams, exApps, histories, storage, buckets }));

  return router;
}

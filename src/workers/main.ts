import { PostgresApiKeyStore } from '../lib/apikey/postgresApiKeyStore.js';
import { disconnectPrisma } from '../lib/db.js';
import { loadExAppExecConfig } from '../lib/exapp/config.js';
import { configureGlobalHttpTimeouts } from '../lib/http/undiciConfig.js';
import { createExAppInvoker } from '../lib/exapp/exAppInvoker.js';
import { logger } from '../lib/logger.js';
import { loadQueueConfig } from '../lib/queue/config.js';
import { ExAppQueue } from '../lib/queue/exAppQueue.js';
import { createSqsClient } from '../lib/queue/sqsClient.js';
import { SeaweedFsStorage } from '../lib/storage/seaweedFsStorage.js';
import { createTranscriptionAdapter } from '../transcription/factory.js';
import { ExAppRepository } from '../repositories/exAppRepository.js';
import { InvokeHistoryRepository } from '../repositories/invokeHistoryRepository.js';
import { TranscriptionJobRepository } from '../repositories/transcriptionJobRepository.js';
import { createExAppJobProcessor } from './processExAppJob.js';
import { createTranscriptionJobProcessor } from './processTranscriptionJob.js';
import { runPollExAppStatus } from './pollExAppStatus.js';

/**
 * 非同期ワーカーの起動エントリ。ElasticMQ の 2 キューを並走ポーリングする（同一コンテナ・1 プロセス）。
 *
 * 1) ExApp 実行状態確認（pollExAppStatus）：履歴キー復号 → 状態確認 → invoke_ex_app_histories 更新。実状態確認は
 *    seam（検証用 checker を注入）。
 * 2) 文字起こし（pollTranscriptionStatus）：jobName で transcription_jobs を引き、音声 DL → faster-whisper →
 *    正規化 → COMPLETED 書き戻し。Whisper 設定（WHISPER_*）と音声バケット（AUDIO_BUCKET_NAME）が
 *    必要。両ループは独立に長ポーリングし、Promise.all で待つ（一方の重い推論が他方を塞がない）。
 */
// fetch(undici) の既定 300s タイムアウトを延長（他経路の fetch 前に設定）。
configureGlobalHttpTimeouts();

const config = loadQueueConfig();
const sqs = createSqsClient(config);

const waitTimeSeconds = process.env.WORKER_WAIT_SECONDS ? Number(process.env.WORKER_WAIT_SECONDS) : undefined;

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'worker shutting down');
    stopping = true;
  });
}
const shouldStop = () => stopping;

// --- 1) ExApp 実行状態確認ループ ---
// 本実装：worker が ExApp endpoint を実際に叩く（初回 POST→同期 outputs／非同期 202+status_url polling）。
// apiKey は ApiKeyStore 実ストア（getApiKey で復号）、artifacts は artifactsBucket へ退避する。
const exAppQueue = new ExAppQueue(sqs, config.queueUrl);
// inputs 退避（読取時の透過復元）を有効化：worker は findExecution で退避済み inputs を復元して endpoint へ送る。
const histories = new InvokeHistoryRepository(undefined, new SeaweedFsStorage(), process.env.ARTIFACTS_BUCKET_NAME);
const checkStatus = createExAppInvoker({
  exApps: new ExAppRepository(),
  apiKeys: new PostgresApiKeyStore(),
  histories,
  storage: new SeaweedFsStorage(),
  artifactsBucket: process.env.ARTIFACTS_BUCKET_NAME,
  config: loadExAppExecConfig(),
});
const processExApp = createExAppJobProcessor({ histories, checkStatus });

// --- 2) 文字起こしループ ---
const audioBucket = process.env.AUDIO_BUCKET_NAME;
if (!audioBucket) {
  throw new Error('AUDIO_BUCKET_NAME must be set for the transcription worker');
}
const transcribeQueue = new ExAppQueue(sqs, config.transcribeQueueUrl);
const processTranscription = createTranscriptionJobProcessor({
  repo: new TranscriptionJobRepository(),
  storage: new SeaweedFsStorage(),
  adapter: createTranscriptionAdapter(),
  audioBucket,
});

Promise.all([
  runPollExAppStatus(exAppQueue, processExApp, {
    shouldStop,
    waitTimeSeconds,
    component: 'api.worker.exapp',
  }),
  runPollExAppStatus(transcribeQueue, processTranscription, {
    shouldStop,
    waitTimeSeconds,
    component: 'api.worker.transcription',
  }),
])
  .then(() => disconnectPrisma())
  .catch((err: unknown) => {
    logger.error({ error: { message: err instanceof Error ? err.message : String(err) } }, 'worker crashed');
    process.exit(1);
  });

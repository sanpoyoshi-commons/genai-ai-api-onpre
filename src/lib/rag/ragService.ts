import type { EmbeddingClient } from '../llm/embeddingClient.js';
import type { RerankClient } from '../llm/rerankClient.js';
import type {
  ChunkRecord,
  DocumentInsert,
  RagRepositoryLike,
} from '../../repositories/ragRepository.js';
import { getRequestLogger } from '../../middleware/requestContext.js';
import { chunkDocument } from './chunking.js';
import type { RagConfig } from './config.js';
import { reciprocalRankFusion } from './rrf.js';

/**
 * RAG 本体サービス（ingest／search）。
 *
 * ingest＝チャンキング → EmbeddingClient で chunk 本文全体を embedding → RagRepository へ格納
 * （上流 AWS query-expansion-rag 経路 faithful＝chunk 全体 embedding）。切り方の設定と埋め込みモデルの ID を
 * チャンクに残す（抽出テキストから作り直すときの手掛かり）。
 * search＝クエリを embedding → ベクトル検索（pgvector）＋全文検索（pg_bigm）→ RRF 融合 → 上位チャンク取得
 * （ハイブリッド検索のローカル現実解。上流のクラウド LLM 多用検索を置換）。
 * 回答生成（retrieve-and-generate の generate 側）は route 層が LlmClient で行う（本サービスは検索まで）。
 *
 * 依存（EmbeddingClient / RagRepositoryLike / RagConfig）は注入式＝unit テストで fake 差し替え可。
 */

export interface RagServiceDeps {
  embedding: EmbeddingClient;
  repo: RagRepositoryLike;
  config: RagConfig;
  /**
   * リランカ（RAG③・任意）。注入かつ config.rerank.enabled のとき search に rerank 段が入る。未注入/無効/失敗時は
   * RRF 順にフォールバック（後方互換・graceful degradation）。embedding/llm と同じ seam 注入。
   */
  rerank?: RerankClient;
}

export interface IngestInput {
  /** 元文書として記録する内容（3 層のメタを含む。所有者は引数で渡す）。 */
  document: Omit<DocumentInsert, 'ownerUserId'>;
  /** チャンクに切る本文（抽出テキスト）。 */
  text: string;
  /**
   * 1 文書あたりのチャンク数の上限（任意）。超えたら ChunkLimitExceededError を投げ、**文書を作らない**
   * （呼び出し側が原本の後片付けと利用者への説明を行う）。
   */
  maxChunks?: number;
}

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  /**
   * 埋め込みに掛かった時間（ms・整数）。投入は同期で、待ち時間のほとんどがここなので、
   * 呼び出し側がログに出せるように返す（チャンク 0 件のときは 0）。
   */
  embedMs: number;
}

/** チャンク数の上限を超えたため投入を断った（route 層が 400 に変える）。 */
export class ChunkLimitExceededError extends Error {
  constructor(
    readonly chunkCount: number,
    readonly maxChunks: number,
  ) {
    super(`chunk count ${chunkCount} exceeds the limit ${maxChunks}`);
    this.name = 'ChunkLimitExceededError';
  }
}

/** 検索の絞り込み。 */
export interface SearchOptions {
  /** 対象のナレッジ集（空・未指定なら自分のすべて）。呼び出し側が所有を確かめてから渡す。 */
  collectionIds?: string[];
  /** 返す最大件数（未指定なら RAG_TOP_M）。 */
  topK?: number;
}

/** 検索結果 1 件（チャンクに順位付けの手掛かりを添えたもの）。 */
export interface ScoredChunk extends ChunkRecord {
  /** RRF の融合スコア（各検索ソースの 1/(k+rank) の総和）。 */
  score: number;
  /** リランカのスコア（rerank 段が効いたときだけ）。 */
  rerankScore?: number;
}

export class RagService {
  private readonly embedding: EmbeddingClient;
  private readonly repo: RagRepositoryLike;
  private readonly config: RagConfig;
  private readonly rerank?: RerankClient;

  constructor(deps: RagServiceDeps) {
    this.embedding = deps.embedding;
    this.repo = deps.repo;
    this.config = deps.config;
    this.rerank = deps.rerank;
  }

  /** 文書を取り込む：チャンク化→本文全体 embedding→格納。チャンク 0 件でも文書は作る。 */
  async ingest(ownerUserId: string, input: IngestInput, requestId?: string): Promise<IngestResult> {
    const chunks = chunkDocument(input.text, this.config.chunk);
    // 上限の判定は文書を作る前に行う（断ったときに空の文書を残さない）。
    if (input.maxChunks !== undefined && chunks.length > input.maxChunks) {
      throw new ChunkLimitExceededError(chunks.length, input.maxChunks);
    }
    if (chunks.length === 0) {
      const emptyId = await this.repo.createDocument({ ownerUserId, ...input.document });
      return { documentId: emptyId, chunkCount: 0, embedMs: 0 };
    }

    const embedStartedAt = performance.now();
    const out = await this.embedding.embed({ input: chunks.map((c) => c.text), requestId });
    const embedMs = Math.round(performance.now() - embedStartedAt);
    if (out.embeddings.length !== chunks.length) {
      throw new Error(
        `embedding count mismatch: expected ${chunks.length}, got ${out.embeddings.length}`,
      );
    }

    const documentId = await this.repo.createDocument({ ownerUserId, ...input.document });
    // createDocument→insertChunks の順で insert が失敗すると、本文ゼロの孤児文書が残る（検索に出ず、
    // 空文書としてユーザに見え続ける）。失敗時は文書を補償削除してから元例外を再送出し、孤児を残さない
    // （DB 越しの create→insert を跨ぐ整合は、create を真実源とした補償で保つ。transcription C-TRS 項④と同方式）。
    try {
      await this.repo.insertChunks(
        documentId,
        ownerUserId,
        chunks.map((c, i) => ({
          index: c.index,
          text: c.text,
          headerPath: c.headerPath,
          embedding: out.embeddings[i] as number[],
        })),
        { chunkerConfig: this.config.chunk, embeddingModel: out.model },
      );
    } catch (err) {
      await this.repo.deleteDocument(documentId, ownerUserId); // 孤児文書を残さない（補償は best-effort）
      throw err;
    }
    return { documentId, chunkCount: chunks.length, embedMs };
  }

  /**
   * クエリに対しハイブリッド検索（ベクトル＋全文 → RRF）し、上位チャンクを順位付けの手掛かり付きで返す。
   * 0 件は空の配列（文章で「該当なし」を返さない＝呼ぶ側が文字列を突き合わせずに済む）。
   *
   * rerank 有効時（rerank 注入かつ config.rerank.enabled）は候補プールを RERANK_CANDIDATES まで広げて RRF し
   * （over-fetch、肝＝topM=10 だけ rerank すると rank11-20 の正解を取りこぼすため）、cross-encoder で並べ替えてから
   * 最終 topM を返す。rerank 無効/失敗/タイムアウトは RRF 順 topM にフォールバック（後方互換・graceful degradation、
   * RAG を落とさず WARN ログ rerank_degraded を残す）。
   */
  async search(
    ownerUserId: string,
    query: string,
    options?: SearchOptions,
    requestId?: string,
  ): Promise<ScoredChunk[]> {
    const out = await this.embedding.embed({ input: [query], requestId });
    const queryEmbedding = out.embeddings[0];
    if (!queryEmbedding) {
      throw new Error('embedding returned no vector for query');
    }

    const collectionIds = options?.collectionIds;
    const topM = options?.topK ?? this.config.rrf.topM;
    const rerankOn = this.rerank !== undefined && this.config.rerank.enabled;
    // rerank 有効時は候補プールを広げる（RRF topM と各ソース取得数を candidates まで引き上げる）。
    const poolM = rerankOn ? Math.max(this.config.rerank.candidates, topM) : topM;
    const fetchK = rerankOn ? Math.max(this.config.fetchK, poolM) : this.config.fetchK;

    const [vectorHits, bigmHits] = await Promise.all([
      this.repo.vectorSearch(ownerUserId, queryEmbedding, fetchK, collectionIds),
      this.repo.bigmSearch(
        ownerUserId,
        query,
        fetchK,
        this.config.bigmSimilarityLimit,
        collectionIds,
      ),
    ]);

    const fused = reciprocalRankFusion([vectorHits, bigmHits], {
      k: this.config.rrf.k,
      topM: poolM,
    });
    const ids = fused.map((f) => f.id);
    if (ids.length === 0) {
      return [];
    }

    // getChunksByIds は順不同で返るため、RRF 順位に並べ替える。
    const records = await this.repo.getChunksByIds(ownerUserId, ids);
    const byId = new Map(records.map((r) => [r.id, r]));
    const ranked = fused
      .map((f) => {
        const record = byId.get(f.id);
        return record ? { ...record, score: f.score } : undefined;
      })
      .filter((r): r is ScoredChunk => r !== undefined);

    if (!rerankOn) {
      return ranked.slice(0, topM);
    }
    return this.applyRerank(query, ranked, topM, requestId);
  }

  /**
   * クエリに対し検索し、上位チャンクを返す（回答生成の context 用＝スコアを落とした形）。
   * `search` の薄い包み（`/rag/query` の経路が使う）。
   */
  async retrieve(
    ownerUserId: string,
    question: string,
    requestId?: string,
    options?: SearchOptions,
  ): Promise<ChunkRecord[]> {
    return this.search(ownerUserId, question, options, requestId);
  }

  /**
   * 候補チャンクを cross-encoder で並べ替え、先頭 topM を返す。失敗時は RRF 順 topM にフォールバック
   * （graceful degradation、WARN rerank_degraded）。rerank 呼び出しは this.rerank（rerankOn 判定済み）。
   */
  private async applyRerank(
    question: string,
    ranked: ScoredChunk[],
    topM: number,
    requestId?: string,
  ): Promise<ScoredChunk[]> {
    const rerank = this.rerank;
    if (!rerank) {
      return ranked.slice(0, topM);
    }
    try {
      const result = await rerank.rerank({
        query: question,
        candidates: ranked.map((r) => ({ id: r.id, text: r.chunkText })),
        requestId,
      });
      const byId = new Map(ranked.map((r) => [r.id, r]));
      const reordered: ScoredChunk[] = [];
      for (const x of result.results) {
        const record = byId.get(x.id);
        if (record) {
          reordered.push({ ...record, rerankScore: x.score });
        }
      }
      // rerank が一部しか返さない/重複等の異常で空になった場合は RRF 順にフォールバック（取りこぼし防止）。
      if (reordered.length === 0) {
        return ranked.slice(0, topM);
      }
      return reordered.slice(0, topM);
    } catch (err) {
      // rerank 経路の失敗（接続不可・タイムアウト・5xx 等）。RAG を落とさず RRF 順で続行する。
      getRequestLogger().warn(
        {
          component: 'api.rag.rerank',
          event: 'rerank_degraded',
          candidates: ranked.length,
          error: { message: err instanceof Error ? err.message : String(err) },
        },
        'rerank degraded; falling back to RRF order',
      );
      return ranked.slice(0, topM);
    }
  }
}

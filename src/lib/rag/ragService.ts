import type { EmbeddingClient } from '../llm/embeddingClient.js';
import type { RerankClient } from '../llm/rerankClient.js';
import type { ChunkRecord, RagRepositoryLike } from '../../repositories/ragRepository.js';
import { getRequestLogger } from '../../middleware/requestContext.js';
import { chunkDocument } from './chunking.js';
import type { RagConfig } from './config.js';
import { reciprocalRankFusion } from './rrf.js';

/**
 * RAG 本体サービス（ingest／retrieve）。
 *
 * ingest＝チャンキング → EmbeddingClient で chunk 本文全体を embedding → RagRepository へ格納
 * （上流 AWS query-expansion-rag 経路 faithful＝chunk 全体 embedding）。
 * retrieve＝クエリを embedding → ベクトル検索（pgvector）＋全文検索（pg_bigm）→ RRF 融合 → 上位チャンク取得
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
   * リランカ（RAG③・任意）。注入かつ config.rerank.enabled のとき retrieve に rerank 段が入る。未注入/無効/失敗時は
   * RRF 順にフォールバック（後方互換・graceful degradation）。embedding/llm と同じ seam 注入。
   */
  rerank?: RerankClient;
}

export interface IngestInput {
  title: string;
  text: string;
}

export interface IngestResult {
  documentId: string;
  chunkCount: number;
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
    if (chunks.length === 0) {
      const emptyId = await this.repo.createDocument({ ownerUserId, title: input.title });
      return { documentId: emptyId, chunkCount: 0 };
    }

    const out = await this.embedding.embed({ input: chunks.map((c) => c.text), requestId });
    if (out.embeddings.length !== chunks.length) {
      throw new Error(
        `embedding count mismatch: expected ${chunks.length}, got ${out.embeddings.length}`,
      );
    }

    const documentId = await this.repo.createDocument({ ownerUserId, title: input.title });
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
      );
    } catch (err) {
      await this.repo.deleteDocument(documentId, ownerUserId); // 孤児文書を残さない（補償は best-effort）
      throw err;
    }
    return { documentId, chunkCount: chunks.length };
  }

  /**
   * クエリに対しハイブリッド検索（ベクトル＋全文 → RRF）し、上位チャンクを返す。
   *
   * rerank 有効時（rerank 注入かつ config.rerank.enabled）は候補プールを RERANK_CANDIDATES まで広げて RRF し
   * （over-fetch、肝＝topM=10 だけ rerank すると rank11-20 の正解を取りこぼすため）、cross-encoder で並べ替えてから
   * 最終 topM を返す。rerank 無効/失敗/タイムアウトは RRF 順 topM にフォールバック（後方互換・graceful degradation、
   * RAG を落とさず WARN ログ rerank_degraded を残す）。
   */
  async retrieve(ownerUserId: string, question: string, requestId?: string): Promise<ChunkRecord[]> {
    const out = await this.embedding.embed({ input: [question], requestId });
    const queryEmbedding = out.embeddings[0];
    if (!queryEmbedding) {
      throw new Error('embedding returned no vector for query');
    }

    const topM = this.config.rrf.topM;
    const rerankOn = this.rerank !== undefined && this.config.rerank.enabled;
    // rerank 有効時は候補プールを広げる（RRF topM と各ソース取得数を candidates まで引き上げる）。
    const poolM = rerankOn ? Math.max(this.config.rerank.candidates, topM) : topM;
    const fetchK = rerankOn ? Math.max(this.config.fetchK, poolM) : this.config.fetchK;

    const [vectorHits, bigmHits] = await Promise.all([
      this.repo.vectorSearch(ownerUserId, queryEmbedding, fetchK),
      this.repo.bigmSearch(ownerUserId, question, fetchK, this.config.bigmSimilarityLimit),
    ]);

    const fused = reciprocalRankFusion([vectorHits, bigmHits], { k: this.config.rrf.k, topM: poolM });
    const ids = fused.map((f) => f.id);
    if (ids.length === 0) {
      return [];
    }

    // getChunksByIds は順不同で返るため、RRF 順位に並べ替える。
    const records = await this.repo.getChunksByIds(ownerUserId, ids);
    const byId = new Map(records.map((r) => [r.id, r]));
    const ranked = ids
      .map((id) => byId.get(id))
      .filter((r): r is ChunkRecord => r !== undefined);

    if (!rerankOn) {
      return ranked.slice(0, topM);
    }
    return this.applyRerank(question, ranked, topM, requestId);
  }

  /**
   * 候補チャンクを cross-encoder で並べ替え、先頭 topM を返す。失敗時は RRF 順 topM にフォールバック
   * （graceful degradation、WARN rerank_degraded）。rerank 呼び出しは this.rerank（rerankOn 判定済み）。
   */
  private async applyRerank(
    question: string,
    ranked: ChunkRecord[],
    topM: number,
    requestId?: string,
  ): Promise<ChunkRecord[]> {
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
      const reordered = result.results
        .map((x) => byId.get(x.id))
        .filter((r): r is ChunkRecord => r !== undefined);
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

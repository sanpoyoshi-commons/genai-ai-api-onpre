import type { RerankRequest, RerankResponse } from '../types.js';

/**
 * Rerank 経路アダプタの抽象 IF（RAG リランカ）。
 *
 * embedding の EmbeddingAdapter と同様、chat の LLMAdapter とは別 IF として独立させる。理由＝rerank の
 * バックエンド（TEI ネイティブ /rerank・ruri-v3-reranker-310m）は chat/embeddings のバックエンドと別サービス
 * かつ独自リクエスト形式（{query, texts[]}→[{index, score}]、OpenAI 互換ではない）であり、共通 IF に載せると
 * 全 chat/embedding アダプタに未実装スタブが必要になる。rerank は専用 factory（createRerankAdapter）+ 専用
 * config（loadRerankConfig / RERANK_BACKEND）で完結させる。
 */
export interface RerankAdapter {
  readonly backend: string;
  rerank(req: RerankRequest): Promise<RerankResponse>;
}

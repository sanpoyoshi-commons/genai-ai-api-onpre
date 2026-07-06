import type { EmbeddingsInput, EmbeddingsOutput } from '../types.js';

/**
 * Embedding 経路アダプタの抽象 IF（RAG 用）。
 *
 * chat の LLMAdapter（chat/chatStream）とは別 IF として独立させる。理由＝embedding の
 * バックエンド（TEI/ruri-v3）は chat のバックエンド（Ollama/Bedrock 等）と別サービスであり、chat 用 LLMAdapter
 * に embeddings() を載せると bedrock 等 全 chat アダプタに未実装スタブが必要になる。embedding は専用 factory
 * （createEmbeddingAdapter）+ 専用 config（loadEmbeddingConfig / EMBEDDING_BACKEND）で完結させる。
 */
export interface EmbeddingAdapter {
  readonly backend: string;
  embed(input: EmbeddingsInput): Promise<EmbeddingsOutput>;
}

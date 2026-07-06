import type { EmbeddingAdapter } from './adapters/embeddingBase.js';
import { createOpenAICompatEmbeddingAdapter } from './adapters/openaiCompatEmbeddingAdapter.js';
import { type EmbeddingConfig, loadEmbeddingConfig } from './embeddingConfig.js';

/**
 * EMBEDDING_BACKEND に応じた embedding アダプタを返す（RAG 用 factory）。
 *
 * tei/openai/ollama はいずれも OpenAI 互換 /v1/embeddings を持つため 1 アダプタ
 * （openaiCompatEmbeddingAdapter）で吸収する。経路差（baseURL/apiKey/既定モデル）は
 * loadEmbeddingConfig が解決済み。chat 側 createLlmAdapter とは独立。
 */
export function createEmbeddingAdapter(
  config: EmbeddingConfig = loadEmbeddingConfig(),
): EmbeddingAdapter {
  return createOpenAICompatEmbeddingAdapter(config);
}

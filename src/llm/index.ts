/**
 * LLM 抽象化レイヤーのパブリック IF（text 中心の最小構成）。
 *
 * 消費側（src/lib/llm のブリッジ＝LlmClient seam 実装）はここから adapter/型/エラーを取得する。chat/chatStream
 * の関数 IF は seam（LlmClient.generate/generateStream）を維持する方針のため公開せず、
 * ブリッジが LLMAdapter を直接消費する。抽象化 IF をフルに公開するのは cloud-api 拡張時に再評価。
 */
export type { LLMAdapter } from './adapters/base.js';
export { type BedrockAdapterConfig, createBedrockAdapter } from './adapters/bedrockAdapter.js';
export type { EmbeddingAdapter } from './adapters/embeddingBase.js';
export { createOpenAICompatAdapter, type OpenAICompatConfig } from './adapters/openaiCompatAdapter.js';
export {
  createOpenAICompatEmbeddingAdapter,
  type OpenAICompatEmbeddingConfig,
} from './adapters/openaiCompatEmbeddingAdapter.js';
export { type LlmConfig, loadLlmConfig } from './config.js';
export { type EmbeddingConfig, loadEmbeddingConfig } from './embeddingConfig.js';
export { createEmbeddingAdapter } from './embeddingFactory.js';
export { LLMError, type LLMErrorCode, isLLMError } from './errors.js';
export { createLlmAdapter } from './factory.js';
export type {
  ChatChunk,
  ChatInput,
  ChatOutput,
  ContentBlock,
  EmbeddingsInput,
  EmbeddingsOutput,
  Message,
  MessageRole,
  StopReason,
  Usage,
} from './types.js';

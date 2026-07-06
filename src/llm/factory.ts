import { createBedrockAdapter } from './adapters/bedrockAdapter.js';
import { createOpenAICompatAdapter } from './adapters/openaiCompatAdapter.js';
import type { LLMAdapter } from './adapters/base.js';
import { type LlmConfig, loadLlmConfig } from './config.js';

/**
 * LLM_BACKEND に応じたアダプタを返す（factory）。
 *
 * ollama/vllm/openai/anthropic/gemini はいずれも OpenAI 互換エンドポイントを持つため 1 アダプタ
 * （openaiCompatAdapter）で吸収する。bedrock のみ SigV4 認証＝OpenAI 互換不可のため専用アダプタ
 * （Converse API）へ分岐する。経路差（baseURL/apiKey/region/既定モデル/既定 max_tokens）は
 * loadLlmConfig が解決済み。
 */
export function createLlmAdapter(config: LlmConfig = loadLlmConfig()): LLMAdapter {
  if (config.backend === 'bedrock') {
    return createBedrockAdapter({
      backend: config.backend,
      region: config.region ?? '', // loadLlmConfig が bedrock では region を必須化（空にはならない）。
      defaultModel: config.defaultModel,
      defaultMaxTokens: config.defaultMaxTokens,
      timeoutMs: config.timeoutMs,
    });
  }
  return createOpenAICompatAdapter(config);
}

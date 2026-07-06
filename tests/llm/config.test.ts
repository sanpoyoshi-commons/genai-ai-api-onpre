import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadLlmConfig } from '../../src/llm/config.js';
import { LLMError } from '../../src/llm/errors.js';

// loadLlmConfig は env を引数で受けるため process.env を汚さずに検証できる。
const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

test('ollama: 既定（env なし）で内部 baseURL とダミー apiKey を返す', () => {
  const c = loadLlmConfig(env());
  assert.equal(c.backend, 'ollama');
  assert.equal(c.baseURL, 'http://ollama:11434/v1');
  assert.equal(c.apiKey, 'ollama');
  assert.equal(c.defaultMaxTokens, undefined);
  assert.equal(c.timeoutMs, 1_800_000); // 既定 30 分（CPU 推論の重い生成に対応）
});

test('vllm: 既定で内部 baseURL とダミー apiKey を返す', () => {
  const c = loadLlmConfig(env({ LLM_BACKEND: 'vllm' }));
  assert.equal(c.backend, 'vllm');
  assert.equal(c.baseURL, 'http://vllm:8000/v1');
  assert.equal(c.apiKey, 'vllm');
});

test('openai: API キー必須（未設定は AUTHENTICATION）', () => {
  assert.throws(
    () => loadLlmConfig(env({ LLM_BACKEND: 'openai' })),
    (e: unknown) => e instanceof LLMError && e.code === 'AUTHENTICATION',
  );
  const c = loadLlmConfig(env({ LLM_BACKEND: 'openai', OPENAI_API_KEY: 'sk-x' }));
  assert.equal(c.apiKey, 'sk-x');
  assert.equal(c.defaultModel, 'gpt-4o-mini');
});

test('anthropic: API キー必須・互換 baseURL・既定モデル・max_tokens 既定 4096', () => {
  assert.throws(
    () => loadLlmConfig(env({ LLM_BACKEND: 'anthropic' })),
    (e: unknown) => e instanceof LLMError && e.code === 'AUTHENTICATION',
  );
  const c = loadLlmConfig(env({ LLM_BACKEND: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' }));
  assert.equal(c.backend, 'anthropic');
  assert.equal(c.baseURL, 'https://api.anthropic.com/v1');
  assert.equal(c.apiKey, 'sk-ant');
  assert.equal(c.defaultModel, 'claude-3-5-haiku-latest');
  assert.equal(c.defaultMaxTokens, 4096); // 互換レイヤーが max_tokens 必須なため既定を与える
});

test('anthropic: env で baseURL/モデル/max_tokens を上書きできる', () => {
  const c = loadLlmConfig(
    env({
      LLM_BACKEND: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant',
      ANTHROPIC_BASE_URL: 'https://proxy.example/v1',
      ANTHROPIC_DEFAULT_CHAT_MODEL: 'claude-3-5-sonnet-latest',
      ANTHROPIC_MAX_TOKENS: '8192',
    }),
  );
  assert.equal(c.baseURL, 'https://proxy.example/v1');
  assert.equal(c.defaultModel, 'claude-3-5-sonnet-latest');
  assert.equal(c.defaultMaxTokens, 8192);
});

test('gemini: API キー必須・互換 baseURL・既定モデル・max_tokens 既定なし', () => {
  assert.throws(
    () => loadLlmConfig(env({ LLM_BACKEND: 'gemini' })),
    (e: unknown) => e instanceof LLMError && e.code === 'AUTHENTICATION',
  );
  const c = loadLlmConfig(env({ LLM_BACKEND: 'gemini', GEMINI_API_KEY: 'k' }));
  assert.equal(c.backend, 'gemini');
  assert.equal(c.baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(c.defaultModel, 'gemini-1.5-flash');
  assert.equal(c.defaultMaxTokens, undefined); // gemini は max_tokens 任意
});

test('LLM_BACKEND は大文字小文字・前後空白を無視する', () => {
  const c = loadLlmConfig(env({ LLM_BACKEND: '  Anthropic  ', ANTHROPIC_API_KEY: 'k' }));
  assert.equal(c.backend, 'anthropic');
});

test('bedrock: region 必須・既定モデル・max_tokens 既定 4096・baseURL/apiKey は空', () => {
  // region 未設定（BEDROCK_REGION も AWS_REGION も無し）は INVALID_REQUEST。
  assert.throws(
    () => loadLlmConfig(env({ LLM_BACKEND: 'bedrock' })),
    (e: unknown) => e instanceof LLMError && e.code === 'INVALID_REQUEST',
  );
  const c = loadLlmConfig(env({ LLM_BACKEND: 'bedrock', BEDROCK_REGION: 'us-east-1' }));
  assert.equal(c.backend, 'bedrock');
  assert.equal(c.region, 'us-east-1');
  assert.equal(c.baseURL, ''); // SDK が region から解決＝未使用
  assert.equal(c.apiKey, ''); // SigV4＝未使用
  assert.equal(c.defaultModel, 'anthropic.claude-3-5-haiku-20241022-v1:0');
  assert.equal(c.defaultMaxTokens, 4096);
});

test('bedrock: region は BEDROCK_REGION 優先・無ければ AWS_REGION にフォールバック', () => {
  const fallback = loadLlmConfig(env({ LLM_BACKEND: 'bedrock', AWS_REGION: 'ap-northeast-1' }));
  assert.equal(fallback.region, 'ap-northeast-1');
  const preferred = loadLlmConfig(
    env({ LLM_BACKEND: 'bedrock', BEDROCK_REGION: 'us-west-2', AWS_REGION: 'ap-northeast-1' }),
  );
  assert.equal(preferred.region, 'us-west-2'); // BEDROCK_REGION 優先
});

test('未知の経路は NOT_IMPLEMENTED', () => {
  assert.throws(
    () => loadLlmConfig(env({ LLM_BACKEND: 'cohere' })),
    (e: unknown) => e instanceof LLMError && e.code === 'NOT_IMPLEMENTED',
  );
});

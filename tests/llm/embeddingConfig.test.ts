import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEmbeddingConfig } from '../../src/llm/embeddingConfig.js';
import { LLMError } from '../../src/llm/errors.js';

// loadEmbeddingConfig は env を引数で受けるため process.env を汚さずに検証できる。
const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

test('tei: 既定（env なし）で内部 baseURL・ダミー apiKey・ruri-v3 既定モデル', () => {
  const c = loadEmbeddingConfig(env());
  assert.equal(c.backend, 'tei');
  assert.equal(c.baseURL, 'http://tei:80/v1');
  assert.equal(c.apiKey, 'tei');
  assert.equal(c.defaultModel, 'cl-nagoya/ruri-v3-310m');
  assert.equal(c.timeoutMs, 300_000);
});

test('tei: EMBEDDING_BASE_URL / EMBEDDING_MODEL_ID で上書きできる', () => {
  const c = loadEmbeddingConfig(
    env({ EMBEDDING_BASE_URL: 'http://tei.example/v1', EMBEDDING_MODEL_ID: 'custom/model' }),
  );
  assert.equal(c.baseURL, 'http://tei.example/v1');
  assert.equal(c.defaultModel, 'custom/model');
});

test('ollama: 内部 baseURL・ダミー apiKey、既定モデルは env 依存（未設定は undefined）', () => {
  const c = loadEmbeddingConfig(env({ EMBEDDING_BACKEND: 'ollama' }));
  assert.equal(c.backend, 'ollama');
  assert.equal(c.baseURL, 'http://ollama:11434/v1');
  assert.equal(c.apiKey, 'ollama');
  assert.equal(c.defaultModel, undefined);

  const c2 = loadEmbeddingConfig(
    env({ EMBEDDING_BACKEND: 'ollama', OLLAMA_DEFAULT_EMBED_MODEL: 'nomic-embed-text' }),
  );
  assert.equal(c2.defaultModel, 'nomic-embed-text');
});

test('openai: API キー必須（未設定は AUTHENTICATION）・既定モデル text-embedding-3-small', () => {
  assert.throws(
    () => loadEmbeddingConfig(env({ EMBEDDING_BACKEND: 'openai' })),
    (e: unknown) => e instanceof LLMError && e.code === 'AUTHENTICATION',
  );
  const c = loadEmbeddingConfig(env({ EMBEDDING_BACKEND: 'openai', OPENAI_API_KEY: 'sk-x' }));
  assert.equal(c.apiKey, 'sk-x');
  assert.equal(c.baseURL, 'https://api.openai.com/v1');
  assert.equal(c.defaultModel, 'text-embedding-3-small');
});

test('openai: OPENAI_DEFAULT_EMBED_MODEL で既定モデルを上書きできる', () => {
  const c = loadEmbeddingConfig(
    env({
      EMBEDDING_BACKEND: 'openai',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_DEFAULT_EMBED_MODEL: 'text-embedding-3-large',
    }),
  );
  assert.equal(c.defaultModel, 'text-embedding-3-large');
});

test('timeout: EMBEDDING_DEFAULT_TIMEOUT_MS 優先・なければ LLM_DEFAULT_TIMEOUT_MS', () => {
  assert.equal(loadEmbeddingConfig(env({ EMBEDDING_DEFAULT_TIMEOUT_MS: '5000' })).timeoutMs, 5000);
  assert.equal(loadEmbeddingConfig(env({ LLM_DEFAULT_TIMEOUT_MS: '7000' })).timeoutMs, 7000);
});

test('maxClientBatchSize: tei/ollama 既定 8・openai 既定 2048・env で上書き', () => {
  assert.equal(loadEmbeddingConfig(env()).maxClientBatchSize, 8); // tei 既定
  assert.equal(
    loadEmbeddingConfig(env({ EMBEDDING_BACKEND: 'ollama' })).maxClientBatchSize,
    8,
  );
  assert.equal(
    loadEmbeddingConfig(env({ EMBEDDING_BACKEND: 'openai', OPENAI_API_KEY: 'sk-x' })).maxClientBatchSize,
    2048,
  );
  assert.equal(
    loadEmbeddingConfig(env({ EMBEDDING_MAX_CLIENT_BATCH_SIZE: '16' })).maxClientBatchSize,
    16,
  );
  // 不正値（0・非数）は無視して経路既定へフォールバック。
  assert.equal(loadEmbeddingConfig(env({ EMBEDDING_MAX_CLIENT_BATCH_SIZE: '0' })).maxClientBatchSize, 8);
});

test('未対応 backend は NOT_IMPLEMENTED', () => {
  assert.throws(
    () => loadEmbeddingConfig(env({ EMBEDDING_BACKEND: 'bedrock' })),
    (e: unknown) => e instanceof LLMError && e.code === 'NOT_IMPLEMENTED',
  );
});

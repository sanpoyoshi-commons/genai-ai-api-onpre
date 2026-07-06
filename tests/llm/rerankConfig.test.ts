import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LLMError } from '../../src/llm/errors.js';
import { loadRerankConfig } from '../../src/llm/rerankConfig.js';

// loadRerankConfig は env を引数で受けるため process.env を汚さずに検証できる。
const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

test('tei: 既定（env なし）で tei-reranker baseURL・ruri-v3-reranker 既定モデル・60s', () => {
  const c = loadRerankConfig(env());
  assert.equal(c.backend, 'tei');
  assert.equal(c.baseURL, 'http://tei-reranker:80');
  assert.equal(c.defaultModel, 'cl-nagoya/ruri-v3-reranker-310m');
  assert.equal(c.timeoutMs, 60_000);
});

test('tei: RERANK_BASE_URL / RERANK_MODEL_ID / RERANK_DEFAULT_TIMEOUT_MS で上書きできる', () => {
  const c = loadRerankConfig(
    env({
      RERANK_BASE_URL: 'http://rr.example:8080',
      RERANK_MODEL_ID: 'custom/reranker',
      RERANK_DEFAULT_TIMEOUT_MS: '12000',
    }),
  );
  assert.equal(c.baseURL, 'http://rr.example:8080');
  assert.equal(c.defaultModel, 'custom/reranker');
  assert.equal(c.timeoutMs, 12_000);
});

test('未対応 backend（cloud 等）は NOT_IMPLEMENTED', () => {
  assert.throws(
    () => loadRerankConfig(env({ RERANK_BACKEND: 'cohere' })),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'NOT_IMPLEMENTED');
      return true;
    },
  );
});

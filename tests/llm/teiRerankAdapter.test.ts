import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTeiRerankAdapter } from '../../src/llm/adapters/teiRerankAdapter.js';
import { LLMError } from '../../src/llm/errors.js';

// ── 注入用モック fetch（TEI /rerank へのリクエストを捕捉し応答する） ──
type FetchOpts = {
  status?: number;
  json?: unknown;
  body?: string;
  capture?: (url: string, body: Record<string, unknown>) => void;
  throwError?: Error;
};

function makeFetch(opts: FetchOpts): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (opts.throwError) {
      throw opts.throwError;
    }
    const raw = init?.body;
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    opts.capture?.(String(input), parsed);
    if (opts.status && opts.status >= 400) {
      return new Response(opts.body ?? 'error', { status: opts.status });
    }
    return new Response(JSON.stringify(opts.json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const adapterWith = (opts: FetchOpts, timeoutMs = 30_000) =>
  createTeiRerankAdapter({
    backend: 'tei',
    baseURL: 'http://tei-reranker:80',
    defaultModel: 'cl-nagoya/ruri-v3-reranker-310m',
    timeoutMs,
    fetch: makeFetch(opts),
  });

test('rerank: {query, texts[]} を /rerank へ送り、返り index で candidates の id を引き当てる', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const adapter = adapterWith({
    capture: (u, b) => {
      url = u;
      body = b;
    },
    // TEI は score 降順で返す。index は送信 texts の添字（2→0→1 の順）。
    json: [
      { index: 2, score: 0.9 },
      { index: 0, score: 0.5 },
      { index: 1, score: 0.1 },
    ],
  });
  const out = await adapter.rerank({
    model: '',
    query: '休暇は？',
    candidates: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
      { id: 'c', text: 'C' },
    ],
  });

  assert.equal(url, 'http://tei-reranker:80/rerank');
  assert.deepEqual(body, { query: '休暇は？', texts: ['A', 'B', 'C'] });
  // index→id 写像（2=c, 0=a, 1=b）。score 降順を保つ。
  assert.deepEqual(out.results, [
    { id: 'c', score: 0.9 },
    { id: 'a', score: 0.5 },
    { id: 'b', score: 0.1 },
  ]);
  assert.equal(out.model, 'cl-nagoya/ruri-v3-reranker-310m');
});

test('rerank: 範囲外 index は破棄（防御）', async () => {
  const adapter = adapterWith({
    json: [
      { index: 0, score: 0.9 },
      { index: 5, score: 0.8 }, // 範囲外
    ],
  });
  const out = await adapter.rerank({
    model: '',
    query: 'q',
    candidates: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
  });
  assert.deepEqual(out.results, [{ id: 'a', score: 0.9 }]);
});

test('rerank: 候補 0 件は TEI を呼ばず空結果（防御短絡）', async () => {
  let called = false;
  const adapter = createTeiRerankAdapter({
    backend: 'tei',
    baseURL: 'http://tei-reranker:80',
    defaultModel: 'ruri',
    timeoutMs: 30_000,
    fetch: (async () => {
      called = true;
      return new Response('[]', { status: 200 });
    }) as typeof fetch,
  });
  const out = await adapter.rerank({ model: '', query: 'q', candidates: [] });
  assert.deepEqual(out.results, []);
  assert.equal(out.model, 'ruri');
  assert.equal(called, false);
});

test('rerank: 5xx は LLMError（INTERNAL・retryable）へ正規化', async () => {
  const adapter = adapterWith({ status: 503, body: 'overloaded' });
  await assert.rejects(
    () => adapter.rerank({ model: '', query: 'q', candidates: [{ id: 'a', text: 'A' }] }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'INTERNAL');
      assert.equal(err.backend, 'tei');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('rerank: 400 は INVALID_REQUEST（retryable=false）へ正規化', async () => {
  const adapter = adapterWith({ status: 400, body: 'bad' });
  await assert.rejects(
    () => adapter.rerank({ model: '', query: 'q', candidates: [{ id: 'a', text: 'A' }] }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'INVALID_REQUEST');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('rerank: fetch の接続失敗（TypeError）は NETWORK へ正規化', async () => {
  const adapter = adapterWith({ throwError: new TypeError('fetch failed') });
  await assert.rejects(
    () => adapter.rerank({ model: '', query: 'q', candidates: [{ id: 'a', text: 'A' }] }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'NETWORK');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('rerank: timeout（AbortError）は TIMEOUT へ正規化', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const adapter = adapterWith({ throwError: abort });
  await assert.rejects(
    () => adapter.rerank({ model: '', query: 'q', candidates: [{ id: 'a', text: 'A' }] }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

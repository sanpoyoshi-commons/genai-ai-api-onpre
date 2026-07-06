import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAICompatEmbeddingAdapter } from '../../src/llm/adapters/openaiCompatEmbeddingAdapter.js';
import { LLMError } from '../../src/llm/errors.js';

// ── 注入用モック fetch（openai SDK が組み立てる /embeddings リクエストへ応答する） ──
type FetchOpts = {
  status?: number;
  json?: unknown;
  capture?: (body: Record<string, unknown>) => void;
};

function makeFetch(opts: FetchOpts): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    opts.capture?.(body);
    if (opts.status && opts.status >= 400) {
      return new Response('error', { status: opts.status });
    }
    return new Response(JSON.stringify(opts.json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const adapterWith = (opts: FetchOpts, defaultModel = 'cl-nagoya/ruri-v3-310m') =>
  createOpenAICompatEmbeddingAdapter({
    backend: 'tei',
    baseURL: 'http://tei:80/v1',
    apiKey: 'tei',
    defaultModel,
    timeoutMs: 30_000,
    fetch: makeFetch(opts),
  });

const embeddingRes = (vectors: number[][], model = 'cl-nagoya/ruri-v3-310m') => ({
  object: 'list',
  model,
  data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
  usage: { prompt_tokens: 8, total_tokens: 8 },
});

test('embed: ベクトル・model・usage を写像（ローカルは estimatedCostUsd=0）', async () => {
  const adapter = adapterWith({ json: embeddingRes([[0.1, 0.2, 0.3]]) });
  const out = await adapter.embed({ model: 'cl-nagoya/ruri-v3-310m', input: ['こんにちは'] });
  assert.deepEqual(out.embeddings, [[0.1, 0.2, 0.3]]);
  assert.equal(out.model, 'cl-nagoya/ruri-v3-310m');
  assert.deepEqual(out.usage, { promptTokens: 8, totalTokens: 8, estimatedCostUsd: 0 });
});

test('embed: data を index 昇順に並べ直して input と対応させる', async () => {
  // SDK レスポンスの data が順不同で返るケース（index で並べ直す）。
  const adapter = adapterWith({
    json: {
      object: 'list',
      model: 'm',
      data: [
        { object: 'embedding', index: 1, embedding: [9] },
        { object: 'embedding', index: 0, embedding: [1] },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    },
  });
  const out = await adapter.embed({ model: 'm', input: ['a', 'b'] });
  assert.deepEqual(out.embeddings, [[1], [9]]);
});

test('embed: model 空のとき config の既定モデルへ委譲', async () => {
  let sentModel: unknown;
  const adapter = adapterWith({ json: embeddingRes([[0]]), capture: (b) => (sentModel = b.model) });
  await adapter.embed({ model: '', input: ['hi'] });
  assert.equal(sentModel, 'cl-nagoya/ruri-v3-310m');
});

test('embed: model も既定も空なら INVALID_REQUEST', async () => {
  const adapter = adapterWith({ json: embeddingRes([[0]]) }, ''); // defaultModel 空
  await assert.rejects(
    () => adapter.embed({ model: '', input: ['hi'] }),
    (e: unknown) => e instanceof LLMError && e.code === 'INVALID_REQUEST',
  );
});

test('embed: 入力が空配列なら INVALID_REQUEST（API を叩かない）', async () => {
  let called = false;
  const adapter = adapterWith({ json: embeddingRes([]), capture: () => (called = true) });
  await assert.rejects(
    () => adapter.embed({ model: 'm', input: [] }),
    (e: unknown) => e instanceof LLMError && e.code === 'INVALID_REQUEST',
  );
  assert.equal(called, false);
});

test('embed: dimensions 指定時のみ送る（未指定は省略＝TEI/ruri は固定次元）', async () => {
  let withDim: unknown;
  const a1 = adapterWith({ json: embeddingRes([[0]]), capture: (b) => (withDim = b.dimensions) });
  await a1.embed({ model: 'm', input: ['x'], dimensions: 256 });
  assert.equal(withDim, 256);

  let present = true;
  const a2 = adapterWith({
    json: embeddingRes([[0]]),
    capture: (b) => (present = 'dimensions' in b),
  });
  await a2.embed({ model: 'm', input: ['x'] });
  assert.equal(present, false);
});

test('embed: maxClientBatchSize 超過時は分割して順序保持で連結＋usage 合算', async () => {
  // 各リクエストの input をそのまま echo（embedding=[Number(s)]）して順序を検証。tei の 422 回避の核。
  const calls: string[][] = [];
  const fetchMock = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const inp = (JSON.parse(init?.body as string) as { input: string[] }).input;
    calls.push(inp);
    const data = inp.map((s, index) => ({ object: 'embedding', index, embedding: [Number(s)] }));
    return new Response(
      JSON.stringify({ object: 'list', model: 'm', data, usage: { prompt_tokens: inp.length, total_tokens: inp.length } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const adapter = createOpenAICompatEmbeddingAdapter({
    backend: 'tei',
    baseURL: 'http://tei:80/v1',
    apiKey: 'tei',
    defaultModel: 'm',
    timeoutMs: 30_000,
    maxClientBatchSize: 2,
    fetch: fetchMock,
  });
  const out = await adapter.embed({ model: 'm', input: ['1', '2', '3', '4', '5'] });
  assert.deepEqual(calls, [['1', '2'], ['3', '4'], ['5']]); // 2 件ずつ分割
  assert.deepEqual(out.embeddings, [[1], [2], [3], [4], [5]]); // 全体で input と対応
  assert.deepEqual(out.usage, { promptTokens: 5, totalTokens: 5, estimatedCostUsd: 0 }); // usage 合算
});

test('embed: 件数が maxClientBatchSize 以下なら 1 リクエスト（分割しない）', async () => {
  let calls = 0;
  const adapter = createOpenAICompatEmbeddingAdapter({
    backend: 'tei',
    baseURL: 'http://tei:80/v1',
    apiKey: 'tei',
    defaultModel: 'm',
    timeoutMs: 30_000,
    maxClientBatchSize: 8,
    fetch: makeFetch({ json: embeddingRes([[1], [2]]), capture: () => (calls += 1) }),
  });
  const out = await adapter.embed({ model: 'm', input: ['a', 'b'] });
  assert.equal(calls, 1);
  assert.deepEqual(out.embeddings, [[1], [2]]);
});

test('embed: 401 は AUTHENTICATION（retryable=false）', async () => {
  const adapter = adapterWith({ status: 401 });
  await assert.rejects(
    () => adapter.embed({ model: 'm', input: ['x'] }),
    (e: unknown) => e instanceof LLMError && e.code === 'AUTHENTICATION' && e.retryable === false,
  );
});

test('embed: 429 は RATE_LIMIT（retryable=true）', async () => {
  const adapter = adapterWith({ status: 429 });
  await assert.rejects(
    () => adapter.embed({ model: 'm', input: ['x'] }),
    (e: unknown) => e instanceof LLMError && e.code === 'RATE_LIMIT' && e.retryable === true,
  );
});

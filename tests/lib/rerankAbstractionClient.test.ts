import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RerankAdapter } from '../../src/llm/adapters/rerankBase.js';
import type { RerankRequest, RerankResponse } from '../../src/llm/types.js';
import { RerankAbstractionClient } from '../../src/lib/llm/rerankAbstractionClient.js';

// ── fake adapter（rerank は固定応答＋入力捕捉） ──
function fakeAdapter(opts: {
  output?: RerankResponse;
  capture?: (req: RerankRequest) => void;
}): RerankAdapter {
  return {
    backend: 'fake',
    async rerank(req) {
      opts.capture?.(req);
      return opts.output ?? { results: [{ id: req.candidates[0]?.id ?? '', score: 1 }], model: 'fake-model' };
    },
  };
}

test('rerank: アダプタの RerankResponse を素通しで返す', async () => {
  const client = new RerankAbstractionClient(() =>
    fakeAdapter({ output: { results: [{ id: 'b', score: 0.9 }, { id: 'a', score: 0.1 }], model: 'ruri' } }),
  );
  const out = await client.rerank({
    query: 'q',
    candidates: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
  });
  assert.deepEqual(out.results, [{ id: 'b', score: 0.9 }, { id: 'a', score: 0.1 }]);
  assert.equal(out.model, 'ruri');
});

test('rerank: model 未指定は空文字へ写像（アダプタの既定モデル委譲に乗せる）', async () => {
  let captured: RerankRequest | undefined;
  const client = new RerankAbstractionClient(() => fakeAdapter({ capture: (r) => (captured = r) }));
  await client.rerank({ query: 'q', candidates: [{ id: 'a', text: 'A' }], requestId: 'r' });
  assert.equal(captured?.model, '');
  assert.equal(captured?.query, 'q');
  assert.deepEqual(captured?.candidates, [{ id: 'a', text: 'A' }]);
  assert.equal(captured?.requestId, 'r');
});

test('rerank: model 指定はそのまま渡す', async () => {
  let captured: RerankRequest | undefined;
  const client = new RerankAbstractionClient(() => fakeAdapter({ capture: (r) => (captured = r) }));
  await client.rerank({ query: 'q', candidates: [{ id: 'a', text: 'A' }], model: 'cl-nagoya/ruri-v3-reranker-310m' });
  assert.equal(captured?.model, 'cl-nagoya/ruri-v3-reranker-310m');
});

test('rerank: アダプタ例外はそのまま再送出（呼び出し側 RagService がフォールバック）', async () => {
  const boom = new Error('rerank down');
  const client = new RerankAbstractionClient(() => ({
    backend: 'fake',
    async rerank() {
      throw boom;
    },
  }));
  await assert.rejects(
    () => client.rerank({ query: 'q', candidates: [{ id: 'a', text: 'A' }] }),
    (err) => err === boom,
  );
});

test('adapter は lazy 生成（複数呼び出しでも factory は 1 回）', async () => {
  let built = 0;
  const client = new RerankAbstractionClient(() => {
    built += 1;
    return fakeAdapter({});
  });
  await client.rerank({ query: 'q', candidates: [{ id: 'a', text: 'A' }] });
  await client.rerank({ query: 'q', candidates: [{ id: 'b', text: 'B' }] });
  assert.equal(built, 1);
});

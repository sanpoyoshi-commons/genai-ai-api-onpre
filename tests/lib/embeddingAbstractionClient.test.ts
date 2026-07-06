import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EmbeddingAdapter } from '../../src/llm/adapters/embeddingBase.js';
import type { EmbeddingsInput, EmbeddingsOutput } from '../../src/llm/types.js';
import { EmbeddingAbstractionClient } from '../../src/lib/llm/embeddingAbstractionClient.js';

// ── fake adapter（embed は固定応答＋入力捕捉） ──
function fakeAdapter(opts: {
  output?: EmbeddingsOutput;
  capture?: (input: EmbeddingsInput) => void;
}): EmbeddingAdapter {
  return {
    backend: 'fake',
    async embed(input) {
      opts.capture?.(input);
      return (
        opts.output ?? {
          embeddings: [[0.1, 0.2]],
          model: 'fake-model',
          usage: { promptTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        }
      );
    },
  };
}

test('embed: アダプタの EmbeddingsOutput を素通しで返す', async () => {
  const client = new EmbeddingAbstractionClient(() => fakeAdapter({}));
  const out = await client.embed({ input: ['こんにちは'], requestId: 'r' });
  assert.deepEqual(out.embeddings, [[0.1, 0.2]]);
  assert.equal(out.model, 'fake-model');
});

test('embed: model 未指定は空文字へ写像（アダプタの既定モデル委譲に乗せる）', async () => {
  let captured: EmbeddingsInput | undefined;
  const client = new EmbeddingAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.embed({ input: ['x'], requestId: 'r' });
  assert.equal(captured?.model, '');
  assert.deepEqual(captured?.input, ['x']);
  assert.equal(captured?.requestId, 'r');
});

test('embed: model 指定はそのまま渡す', async () => {
  let captured: EmbeddingsInput | undefined;
  const client = new EmbeddingAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.embed({ model: 'cl-nagoya/ruri-v3-310m', input: ['x'] });
  assert.equal(captured?.model, 'cl-nagoya/ruri-v3-310m');
});

test('adapter は lazy 生成（複数呼び出しでも factory は 1 回）', async () => {
  let built = 0;
  const client = new EmbeddingAbstractionClient(() => {
    built += 1;
    return fakeAdapter({});
  });
  await client.embed({ input: ['a'] });
  await client.embed({ input: ['b'] });
  assert.equal(built, 1);
});

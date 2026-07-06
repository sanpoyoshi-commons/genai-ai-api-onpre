import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LLMAdapter } from '../../src/llm/adapters/base.js';
import type { ChatChunk, ChatInput, ChatOutput } from '../../src/llm/types.js';
import { LlmAbstractionClient } from '../../src/lib/llm/llmAbstractionClient.js';

// ── fake adapter（chat は固定応答＋入力捕捉、chatStream は与えたチャンク列を yield） ──
function fakeAdapter(opts: {
  output?: ChatOutput;
  chunks?: ChatChunk[];
  capture?: (input: ChatInput) => void;
}): LLMAdapter {
  return {
    backend: 'fake',
    async chat(input) {
      opts.capture?.(input);
      return (
        opts.output ?? {
          message: { role: 'assistant', content: '答え' },
          stopReason: 'end_turn',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        }
      );
    },
    async *chatStream(input) {
      opts.capture?.(input);
      for (const c of opts.chunks ?? []) {
        yield c;
      }
    },
  };
}

test('generate: 完成テキストを返す', async () => {
  const client = new LlmAbstractionClient(() => fakeAdapter({}));
  const text = await client.generate({ model: 'm', messages: [{ role: 'user', content: 'q' }], requestId: 'r' });
  assert.equal(text, '答え');
});

test('generate: UnrecordedMessage を text 中心の Message へ写像（extraData は落とす）', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.generate({
    model: 'mistral:7b',
    messages: [
      { role: 'user', content: 'q', extraData: [{ type: 'image', name: 'x', source: { type: 'base64', mediaType: 'image/png', data: 'AA' } }] },
    ],
    requestId: 'r',
  });
  assert.equal(captured?.model, 'mistral:7b');
  assert.deepEqual(captured?.messages, [{ role: 'user', content: 'q' }]);
});

test('generateStream: text_delta のみを文字列で yield（message_stop/usage は無視）', async () => {
  const client = new LlmAbstractionClient(() =>
    fakeAdapter({
      chunks: [
        { type: 'text_delta', text: 'あ' },
        { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } },
        { type: 'text_delta', text: 'い' },
        { type: 'message_stop', stopReason: 'end_turn' },
      ],
    }),
  );
  const tokens: string[] = [];
  for await (const t of client.generateStream({ model: 'm', messages: [], requestId: 'r' })) {
    tokens.push(t);
  }
  assert.deepEqual(tokens, ['あ', 'い']);
});

test('generateStream: error チャンクは throw する', async () => {
  const boom = new Error('backend down');
  const client = new LlmAbstractionClient(() =>
    fakeAdapter({ chunks: [{ type: 'error', error: boom as never }] }),
  );
  await assert.rejects(async () => {
    for await (const _ of client.generateStream({ model: 'm', messages: [], requestId: 'r' })) {
      // 反復で error チャンクに達した時点で throw される
    }
  });
});

test('adapter は lazy 生成（複数呼び出しでも factory は 1 回）', async () => {
  let built = 0;
  const client = new LlmAbstractionClient(() => {
    built += 1;
    return fakeAdapter({});
  });
  await client.generate({ model: 'm', messages: [], requestId: 'r1' });
  await client.generate({ model: 'm', messages: [], requestId: 'r2' });
  assert.equal(built, 1);
});

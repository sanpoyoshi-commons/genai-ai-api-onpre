import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { createBedrockAdapter } from '../../src/llm/adapters/bedrockAdapter.js';
import { LLMError } from '../../src/llm/errors.js';
import type { ChatChunk } from '../../src/llm/types.js';

type FakeOpts = {
  converseOutput?: unknown;
  streamEvents?: unknown[];
  error?: Error;
};

// 注入用モック client。ConverseCommand / ConverseStreamCommand を instanceof で分岐し、送信コマンドを記録する。
function fakeClient(opts: FakeOpts) {
  const sent: Array<ConverseCommand | ConverseStreamCommand> = [];
  const client = {
    sent,
    async send(command: ConverseCommand | ConverseStreamCommand) {
      sent.push(command);
      if (opts.error) {
        throw opts.error;
      }
      if (command instanceof ConverseStreamCommand) {
        return { stream: toAsyncIterable(opts.streamEvents ?? []) };
      }
      return opts.converseOutput;
    },
  };
  return client as unknown as BedrockRuntimeClient & {
    sent: Array<ConverseCommand | ConverseStreamCommand>;
  };
}

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

const adapterWith = (client: BedrockRuntimeClient, defaultModel = 'anthropic.claude-3-5-haiku-20241022-v1:0') =>
  createBedrockAdapter({
    backend: 'bedrock',
    region: 'us-east-1',
    defaultModel,
    defaultMaxTokens: 4096,
    timeoutMs: 30_000,
    client,
  });

const converseOutput = (text: string) => ({
  output: { message: { role: 'assistant', content: [{ text }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
});

test('chat: Converse 出力テキスト・stopReason・usage を写像（estimatedCostUsd=0）', async () => {
  const client = fakeClient({ converseOutput: converseOutput('東京です') });
  const out = await adapterWith(client).chat({
    model: 'm',
    messages: [{ role: 'user', content: '首都は？' }],
  });
  assert.equal(out.message.content, '東京です');
  assert.equal(out.stopReason, 'end_turn');
  assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 3, totalTokens: 13, estimatedCostUsd: 0 });
});

test('chat: system は messages から分離し system パラメータへ・maxTokens 既定を inferenceConfig へ', async () => {
  const client = fakeClient({ converseOutput: converseOutput('ok') });
  await adapterWith(client).chat({
    model: 'claude-x',
    system: 'あなたは助手です',
    messages: [
      { role: 'system', content: '簡潔に' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'やあ' },
    ],
  });
  const input = (client.sent[0] as ConverseCommand).input;
  assert.equal(input.modelId, 'claude-x');
  // system は input.system / messages（user/assistant のみ）へ正しく振り分く。
  assert.deepEqual(input.system, [{ text: 'あなたは助手です' }, { text: '簡潔に' }]);
  assert.equal(input.messages?.length, 2);
  assert.deepEqual(input.messages?.[0], { role: 'user', content: [{ text: 'hi' }] });
  assert.deepEqual(input.messages?.[1], { role: 'assistant', content: [{ text: 'やあ' }] });
  assert.equal(input.inferenceConfig?.maxTokens, 4096); // 既定が乗る
});

test('chat: model 空のとき config の既定モデルへ委譲', async () => {
  const client = fakeClient({ converseOutput: converseOutput('ok') });
  await adapterWith(client).chat({ model: '', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((client.sent[0] as ConverseCommand).input.modelId, 'anthropic.claude-3-5-haiku-20241022-v1:0');
});

test('chat: model も既定も空なら INVALID_REQUEST', async () => {
  const client = fakeClient({ converseOutput: converseOutput('ok') });
  await assert.rejects(
    () => adapterWith(client, '').chat({ model: '', messages: [{ role: 'user', content: 'hi' }] }),
    (e: unknown) => e instanceof LLMError && e.code === 'INVALID_REQUEST',
  );
});

test('chatStream: contentBlockDelta→messageStop→metadata.usage を写像', async () => {
  const client = fakeClient({
    streamEvents: [
      { contentBlockDelta: { delta: { text: 'あ' }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { text: 'い' }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } },
    ],
  });
  const chunks: ChatChunk[] = [];
  for await (const c of adapterWith(client).chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(c);
  }
  assert.deepEqual(
    chunks.filter((c) => c.type === 'text_delta').map((c) => (c.type === 'text_delta' ? c.text : '')),
    ['あ', 'い'],
  );
  assert.ok(chunks.some((c) => c.type === 'message_stop' && c.stopReason === 'end_turn'));
  assert.ok(chunks.some((c) => c.type === 'usage' && c.usage.totalTokens === 5));
});

test('chat: ThrottlingException は RATE_LIMIT（retryable=true）', async () => {
  const client = fakeClient({ error: Object.assign(new Error('rate'), { name: 'ThrottlingException' }) });
  await assert.rejects(
    () => adapterWith(client).chat({ model: 'm', messages: [] }),
    (e: unknown) => e instanceof LLMError && e.code === 'RATE_LIMIT' && e.retryable === true,
  );
});

test('chat: AccessDeniedException は AUTHENTICATION（retryable=false）', async () => {
  const client = fakeClient({ error: Object.assign(new Error('denied'), { name: 'AccessDeniedException' }) });
  await assert.rejects(
    () => adapterWith(client).chat({ model: 'm', messages: [] }),
    (e: unknown) => e instanceof LLMError && e.code === 'AUTHENTICATION' && e.retryable === false,
  );
});

test('chat: ValidationException は INVALID_REQUEST', async () => {
  const client = fakeClient({ error: Object.assign(new Error('bad'), { name: 'ValidationException' }) });
  await assert.rejects(
    () => adapterWith(client).chat({ model: 'm', messages: [] }),
    (e: unknown) => e instanceof LLMError && e.code === 'INVALID_REQUEST',
  );
});

test('chat: 未知例外は $metadata.httpStatusCode で分類（503→INTERNAL retryable）', async () => {
  const client = fakeClient({ error: Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } }) });
  await assert.rejects(
    () => adapterWith(client).chat({ model: 'm', messages: [] }),
    (e: unknown) => e instanceof LLMError && e.code === 'INTERNAL' && e.retryable === true,
  );
});

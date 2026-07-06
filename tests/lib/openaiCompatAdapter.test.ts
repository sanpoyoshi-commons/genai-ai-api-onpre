import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAICompatAdapter } from '../../src/llm/adapters/openaiCompatAdapter.js';
import { LLMError } from '../../src/llm/errors.js';
import type { ChatChunk } from '../../src/llm/types.js';

// ── 注入用モック fetch（openai SDK が組み立てる /chat/completions リクエストへ応答する） ──
type FetchOpts = {
  status?: number;
  json?: unknown;
  sse?: object[];
  capture?: (body: Record<string, unknown>) => void;
};

function sseResponse(chunks: object[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeFetch(opts: FetchOpts): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    opts.capture?.(body);
    if (opts.status && opts.status >= 400) {
      return new Response('error', { status: opts.status });
    }
    if (body.stream) {
      return sseResponse(opts.sse ?? []);
    }
    return new Response(JSON.stringify(opts.json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const adapterWith = (opts: FetchOpts, defaultModel = 'mistral:7b') =>
  createOpenAICompatAdapter({
    backend: 'ollama',
    baseURL: 'http://ollama:11434/v1',
    apiKey: 'ollama',
    defaultModel,
    timeoutMs: 30_000,
    fetch: makeFetch(opts),
  });

const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'mistral:7b',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
});

test('chat: 完成テキスト・stopReason・usage を写像（ローカルは estimatedCostUsd=0）', async () => {
  const adapter = adapterWith({ json: completion('東京です') });
  const out = await adapter.chat({ model: 'mistral:7b', messages: [{ role: 'user', content: '首都は？' }] });
  assert.equal(out.message.content, '東京です');
  assert.equal(out.stopReason, 'end_turn');
  assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 3, totalTokens: 13, estimatedCostUsd: 0 });
});

test('chat: model 空のとき config の既定モデルへ委譲', async () => {
  let sentModel: unknown;
  const adapter = adapterWith({ json: completion('ok'), capture: (b) => (sentModel = b.model) });
  await adapter.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(sentModel, 'mistral:7b');
});

test('chat: model も既定も空なら INVALID_REQUEST', async () => {
  const adapter = adapterWith({ json: completion('ok') }, ''); // defaultModel 空
  await assert.rejects(
    () => adapter.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] }),
    (e: unknown) => e instanceof LLMError && e.code === 'INVALID_REQUEST',
  );
});

test('chatStream: text_delta → message_stop → usage を yield', async () => {
  const adapter = adapterWith({
    sse: [
      { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'あ' }, finish_reason: null }] },
      { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'い' }, finish_reason: null }] },
      { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ],
  });
  const chunks: ChatChunk[] = [];
  for await (const c of adapter.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(c);
  }
  assert.deepEqual(
    chunks.filter((c) => c.type === 'text_delta').map((c) => (c.type === 'text_delta' ? c.text : '')),
    ['あ', 'い'],
  );
  assert.ok(chunks.some((c) => c.type === 'message_stop' && c.stopReason === 'end_turn'));
  assert.ok(chunks.some((c) => c.type === 'usage' && c.usage.totalTokens === 5));
});

test('chat: 401 は AUTHENTICATION（retryable=false）', async () => {
  const adapter = adapterWith({ status: 401 });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [] }),
    (e: unknown) => e instanceof LLMError && e.code === 'AUTHENTICATION' && e.retryable === false,
  );
});

test('chat: 429 は RATE_LIMIT（retryable=true）', async () => {
  const adapter = adapterWith({ status: 429 });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [] }),
    (e: unknown) => e instanceof LLMError && e.code === 'RATE_LIMIT' && e.retryable === true,
  );
});

// ── defaultMaxTokens（anthropic 互換の max_tokens 必須対応） ──
const adapterWithMax = (defaultMaxTokens: number | undefined, capture: FetchOpts['capture']) =>
  createOpenAICompatAdapter({
    backend: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant',
    defaultModel: 'claude-3-5-haiku-latest',
    defaultMaxTokens,
    timeoutMs: 30_000,
    fetch: makeFetch({ json: completion('ok'), capture }),
  });

test('chat: maxTokens 未指定なら config.defaultMaxTokens を送る（anthropic 400 回避）', async () => {
  let sent: unknown;
  const adapter = adapterWithMax(4096, (b) => (sent = b.max_tokens));
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(sent, 4096);
});

test('chat: リクエストの maxTokens は defaultMaxTokens を上書きする', async () => {
  let sent: unknown;
  const adapter = adapterWithMax(4096, (b) => (sent = b.max_tokens));
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  assert.equal(sent, 100);
});

test('chat: defaultMaxTokens なし＋未指定なら max_tokens は省略（ollama/vllm/openai/gemini）', async () => {
  let present = true;
  const adapter = adapterWithMax(undefined, (b) => (present = 'max_tokens' in b));
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(present, false);
});

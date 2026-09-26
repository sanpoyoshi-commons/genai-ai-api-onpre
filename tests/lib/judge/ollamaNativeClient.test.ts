import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJudgeError } from '../../../src/lib/judge/errors.js';
import { OllamaNativeClient } from '../../../src/lib/judge/ollamaNativeClient.js';
import type { JudgePrompt } from '../../../src/lib/judge/prompt.js';

const prompt: JudgePrompt = { system: 'sys', user: 'usr' };

const okBody = (extra: Record<string, unknown> = {}) => ({
  model: 'gemma4:e2b',
  message: { role: 'assistant', content: 'A' },
  prompt_eval_count: 120,
  eval_count: 1,
  logprobs: [
    {
      token: 'A',
      logprob: -0.1,
      top_logprobs: [
        { token: 'A', logprob: -0.1 },
        { token: 'B', logprob: -2.3 },
      ],
    },
  ],
  ...extra,
});

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const clientWith = (fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) =>
  new OllamaNativeClient({
    baseUrl: 'http://ollama:11434/',
    attemptTimeoutMs: 60000,
    maxRetryWaitMs: 60000,
    fetch: fetchImpl,
    sleep: async () => undefined,
    random: () => 0.5,
    now: () => 0,
    ...overrides,
  });

/** 応答しない上流。abort されたら実機と同じく「abort 理由そのもの」で reject する。 */
const stallingFetch = (onCall?: () => void): typeof fetch =>
  ((_input: unknown, init?: { signal?: AbortSignal }) => {
    onCall?.();
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as unknown as typeof fetch;

test('ネイティブ /api/chat へ num_predict:1 / temperature:0 / think:false で送り num_ctx は送らない', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const client = clientWith(async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse(okBody());
  });

  const res = await client.nextTokenLogprobs(prompt, 'gemma4:e2b', 20);

  assert.equal(url, 'http://ollama:11434/api/chat');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(body.logprobs, true);
  assert.equal(body.top_logprobs, 20);
  assert.deepEqual(body.options, { temperature: 0, num_predict: 1 });
  assert.ok(!('num_ctx' in (body.options as Record<string, unknown>)), 'num_ctx は指定しない');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'usr' },
  ]);

  assert.equal(res.model, 'gemma4:e2b');
  assert.equal(res.candidates.length, 2);
  assert.equal(res.promptEvalCount, 120);
  assert.equal(res.evalCount, 1);
});

test('logprobs が message 配下・OpenAI 互換形でも取り出せる', async () => {
  const nested = clientWith(async () =>
    jsonResponse({
      model: 'm',
      message: { role: 'assistant', content: 'A', logprobs: okBody().logprobs },
      logprobs: undefined,
    }),
  );
  assert.equal((await nested.nextTokenLogprobs(prompt, 'm', 20)).candidates.length, 2);

  const openaiStyle = clientWith(async () =>
    jsonResponse({
      model: 'm',
      choices: [{ logprobs: { content: [{ token: 'A', logprob: -0.1, top_logprobs: [{ token: 'A', logprob: -0.1 }] }] } }],
    }),
  );
  assert.equal((await openaiStyle.nextTokenLogprobs(prompt, 'm', 20)).candidates.length, 1);
});

test('logprobs が無ければ 502 相当（OpenAI 互換 URL を叩いた疑いを message に残す）', async () => {
  const client = clientWith(async () => jsonResponse({ model: 'm', message: { content: 'A' } }));
  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20),
    (err: unknown) => isJudgeError(err) && err.code === 'upstream' && err.message.includes('logprobs'),
  );
});

test('5xx はリトライし、成功したら返す', async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = clientWith(
    async () => {
      calls += 1;
      return calls === 1 ? new Response('boom', { status: 500 }) : jsonResponse(okBody());
    },
    { sleep: async (ms: number) => void delays.push(ms) },
  );

  const res = await client.nextTokenLogprobs(prompt, 'm', 20);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [500]); // 初期 0.5 秒（random=0.5 でジッタ 0）
  assert.equal(res.candidates.length, 2);
});

test('429 の Retry-After（秒）を尊重する', async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = clientWith(
    async () => {
      calls += 1;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
        : jsonResponse(okBody());
    },
    { sleep: async (ms: number) => void delays.push(ms) },
  );

  await client.nextTokenLogprobs(prompt, 'm', 20);
  assert.deepEqual(delays, [2000]);
});

test('retry-after-ms も尊重する', async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = clientWith(
    async () => {
      calls += 1;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after-ms': '250' } })
        : jsonResponse(okBody());
    },
    { sleep: async (ms: number) => void delays.push(ms) },
  );

  await client.nextTokenLogprobs(prompt, 'm', 20);
  assert.deepEqual(delays, [250]);
});

test('リトライ対象外（400）は即座に上流エラー、本文はメッセージに載せない', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return new Response('プロンプトを反射した本文', { status: 400 });
  });

  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20),
    (err: unknown) =>
      isJudgeError(err) &&
      err.code === 'upstream' &&
      err.message.includes('HTTP 400') &&
      !err.message.includes('反射'),
  );
  assert.equal(calls, 1);
});

test('リトライ上限（2 回）を超えたら上流エラー', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return new Response('boom', { status: 503 });
  });

  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20),
    (err: unknown) => isJudgeError(err) && err.code === 'upstream',
  );
  assert.equal(calls, 3); // 初回 ＋ 2 リトライ
});

test('per-attempt タイムアウトは再試行対象で、使い切ったらタイムアウト（504 相当）', async () => {
  let calls = 0;
  const client = new OllamaNativeClient({
    baseUrl: 'http://ollama:11434',
    attemptTimeoutMs: 20,
    maxRetryWaitMs: 60000,
    fetch: stallingFetch(() => {
      calls += 1;
    }),
    sleep: async () => undefined,
    random: () => 0.5,
    maxRetries: 1,
  });

  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20),
    (err: unknown) => isJudgeError(err) && err.code === 'timeout',
  );
  assert.equal(calls, 2, '初回 ＋ 1 リトライ');
});

test('呼び出し側の中断は再試行せず、上流への fetch も止める（タイムアウトとは別物）', async () => {
  let calls = 0;
  let upstreamAborted = false;
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        upstreamAborted = true;
        reject(init.signal?.reason);
      });
    });
  }) as unknown as typeof fetch;

  const client = new OllamaNativeClient({
    baseUrl: 'http://ollama:11434',
    attemptTimeoutMs: 5000,
    maxRetryWaitMs: 60000,
    fetch: fetchImpl,
    sleep: async () => undefined,
    random: () => 0.5,
  });

  const controller = new AbortController();
  const pending = client.nextTokenLogprobs(prompt, 'm', 20, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    () => pending,
    (err: unknown) => isJudgeError(err) && err.code === 'client_abort',
  );
  assert.equal(calls, 1, '中断は再試行しない');
  assert.ok(upstreamAborted, '上流への fetch も abort される');
});

test('上限を超える待機を指示されたら、待たずに失敗する', async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = clientWith(
    async () => {
      calls += 1;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
    },
    { sleep: async (ms: number) => void delays.push(ms) },
  );

  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20),
    (err: unknown) => isJudgeError(err) && err.code === 'upstream' && err.message.includes('上限'),
  );
  assert.deepEqual(delays, [], '待機しない');
  assert.equal(calls, 1);
});

test('全体予算を使い切ったらリトライを打ち切る', async () => {
  let clock = 0;
  let calls = 0;
  const client = clientWith(
    async () => {
      calls += 1;
      clock += 400;
      return new Response('boom', { status: 503 });
    },
    { now: () => clock, sleep: async () => undefined },
  );

  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20, { deadlineAt: 1000 }),
    (err: unknown) => isJudgeError(err) && err.code === 'timeout',
  );
  assert.equal(calls, 2, '予算が尽きた時点で打ち切る（リトライ上限 2 回には達しない）');
});

test('予算が尽きていれば上流を叩かない', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return jsonResponse(okBody());
  });

  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20, { deadlineAt: -1 }),
    (err: unknown) => isJudgeError(err) && err.code === 'timeout',
  );
  assert.equal(calls, 0);
});

test('応答ボディが壊れていれば上流エラー（ボディ読み込みもタイムアウトの内側で行う）', async () => {
  const client = clientWith(async () => new Response('{壊れた', { status: 200 }));
  await assert.rejects(
    () => client.nextTokenLogprobs(prompt, 'm', 20),
    (err: unknown) => isJudgeError(err) && err.code === 'upstream' && err.message.includes('解釈'),
  );
});

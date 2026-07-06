import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExAppInvoker, type ExAppInvokerDeps } from '../../src/lib/exapp/exAppInvoker.js';
import type { ExecutionContext, HistoryKey } from '../../src/repositories/invokeHistoryRepository.js';
import type { ReceivedJob } from '../../src/lib/queue/exAppQueue.js';
import type { ExAppExecConfig } from '../../src/lib/exapp/config.js';

const message = { teamId: 't1', exAppId: 'a1', userId: 'u1', createdDate: '2026-06-02T00:00:00.000Z' };
const job: ReceivedJob = { messageId: 'm1', receiptHandle: 'r1', body: '', receiveCount: 1 };

const baseConfig: ExAppExecConfig = {
  allowPrivateEndpoints: true,
  endpointAllowlist: ['localhost', 'echo-app', '127.0.0.1'],
  httpTimeoutMs: 5000,
  artifactThresholdBytes: 10_240,
};

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

interface Recorder {
  fetchCalls: { url: string; init: RequestInit }[];
  saved: { key: HistoryKey; statusUrl: string; requestId: string | null }[];
  puts: { bucket: string; key: string; size: number }[];
}

function makeInvoker(opts: {
  ctx: ExecutionContext | null;
  endpoint?: string | null;
  apiKey?: string | null;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  config?: Partial<ExAppExecConfig>;
  artifactsBucket?: string;
}) {
  const rec: Recorder = { fetchCalls: [], saved: [], puts: [] };
  const deps: ExAppInvokerDeps = {
    exApps: { async findEndpoint() { return opts.endpoint === undefined ? 'http://echo-app:3000/run' : opts.endpoint; } },
    apiKeys: { async getApiKey() { return opts.apiKey === undefined ? 'secret-key' : opts.apiKey; } },
    histories: {
      async findExecution() { return opts.ctx; },
      async saveExternalState(key, statusUrl, requestId) { rec.saved.push({ key, statusUrl, requestId }); },
    },
    storage: {
      async putObject(bucket, key, body) { rec.puts.push({ bucket, key, size: body.byteLength }); },
    },
    artifactsBucket: opts.artifactsBucket ?? 'artifacts',
    config: { ...baseConfig, ...opts.config },
    fetchFn: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      rec.fetchCalls.push({ url, init: init ?? {} });
      return opts.fetchImpl(url, init ?? {});
    },
  };
  return { checker: createExAppInvoker(deps), rec };
}

const freshCtx = (): ExecutionContext => ({ inputs: { question: 'hi' }, statusUrl: null, externalRequestId: null, status: 'running' });

test('sync outputs success', async () => {
  const { checker, rec } = makeInvoker({
    ctx: freshCtx(),
    fetchImpl: async () => jsonResponse(200, { outputs: 'hello world' }),
  });
  const res = await checker(message, job);
  assert.deepEqual(res, { done: true, status: 'success', outputs: 'hello world' });
  // 初回 POST：headers と body を検証。
  const call = rec.fetchCalls[0];
  assert.equal(call?.init.method, 'POST');
  const headers = call?.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'secret-key');
  assert.equal(headers['x-user-id'], 'u1');
  assert.deepEqual(JSON.parse(call?.init.body as string), { inputs: { question: 'hi' } });
});

test('sync non-JSON body treated as outputs text', async () => {
  const { checker } = makeInvoker({
    ctx: freshCtx(),
    fetchImpl: async () => textResponse(200, 'just plain text'),
  });
  const res = await checker(message, job);
  assert.deepEqual(res, { done: true, status: 'success', outputs: 'just plain text' });
});

test('sync >=400 is error', async () => {
  const { checker } = makeInvoker({
    ctx: freshCtx(),
    fetchImpl: async () => jsonResponse(500, { message: 'boom' }),
  });
  const res = await checker(message, job);
  assert.equal(res.done, true);
  assert.equal(res.status, 'error');
});

test('async 202 + status_url persists statusUrl and defers', async () => {
  const { checker, rec } = makeInvoker({
    ctx: freshCtx(),
    endpoint: 'http://echo-app:3000/requests',
    fetchImpl: async () => jsonResponse(202, { outputs: 'accepted', request_id: 'req-1', status: 'PENDING', status_url: '/status/req-1' }),
  });
  const res = await checker(message, job);
  assert.deepEqual(res, { done: false });
  assert.equal(rec.saved.length, 1);
  // 相対 status_url が endpoint origin に解決される。
  assert.equal(rec.saved[0]?.statusUrl, 'http://echo-app:3000/status/req-1');
  assert.equal(rec.saved[0]?.requestId, 'req-1');
});

test('async 202 with cross-origin status_url is rejected (same-origin guard)', async () => {
  // status_url が allowlist 許可済みでも、初回 endpoint と異なる origin なら fail-closed で拒否する。
  const { checker, rec } = makeInvoker({
    ctx: freshCtx(),
    endpoint: 'http://echo-app:3000/requests',
    config: { allowPrivateEndpoints: true, endpointAllowlist: ['echo-app', 'other-app'] },
    fetchImpl: async () => jsonResponse(202, { request_id: 'req-1', status: 'PENDING', status_url: 'http://other-app:3000/status/req-1' }),
  });
  const res = await checker(message, job);
  assert.equal(res.done, true);
  assert.equal(res.status, 'error');
  // origin 不一致のため statusUrl は永続化されない。
  assert.equal(rec.saved.length, 0);
});

test('async polling COMPLETED returns success', async () => {
  const { checker, rec } = makeInvoker({
    ctx: { inputs: {}, statusUrl: 'http://echo-app:3000/status/req-1', externalRequestId: 'req-1', status: 'running' },
    fetchImpl: async () => jsonResponse(200, { status: 'COMPLETED', outputs: 'final answer' }),
  });
  const res = await checker(message, job);
  assert.deepEqual(res, { done: true, status: 'success', outputs: 'final answer' });
  // polling は GET。
  assert.equal(rec.fetchCalls[0]?.init.method, 'GET');
});

test('async polling IN_PROGRESS defers', async () => {
  const { checker } = makeInvoker({
    ctx: { inputs: {}, statusUrl: 'http://echo-app:3000/status/req-1', externalRequestId: 'req-1', status: 'running' },
    fetchImpl: async () => jsonResponse(200, { status: 'IN_PROGRESS', progress: '3/5' }),
  });
  assert.deepEqual(await checker(message, job), { done: false });
});

test('async polling ERROR returns error', async () => {
  const { checker } = makeInvoker({
    ctx: { inputs: {}, statusUrl: 'http://echo-app:3000/status/req-1', externalRequestId: 'req-1', status: 'running' },
    fetchImpl: async () => jsonResponse(200, { status: 'ERROR', error: { message: 'failed' } }),
  });
  const res = await checker(message, job);
  assert.equal(res.status, 'error');
  assert.equal(res.done, true);
});

test('SSRF guard blocks private endpoint when not allowlisted', async () => {
  const { checker, rec } = makeInvoker({
    ctx: freshCtx(),
    endpoint: 'http://192.168.0.9/run',
    config: { allowPrivateEndpoints: true, endpointAllowlist: ['localhost'] },
    fetchImpl: async () => jsonResponse(200, { outputs: 'x' }),
  });
  const res = await checker(message, job);
  assert.equal(res.status, 'error');
  assert.equal(res.done, true);
  // 外部 fetch は呼ばれない。
  assert.equal(rec.fetchCalls.length, 0);
});

test('SSRF guard blocks private endpoint when opt-in disabled', async () => {
  const { checker, rec } = makeInvoker({
    ctx: freshCtx(),
    endpoint: 'http://localhost:8080/run',
    config: { allowPrivateEndpoints: false, endpointAllowlist: [] },
    fetchImpl: async () => jsonResponse(200, { outputs: 'x' }),
  });
  assert.equal((await checker(message, job)).status, 'error');
  assert.equal(rec.fetchCalls.length, 0);
});

test('artifacts are offloaded to storage and referenced', async () => {
  const pngB64 = Buffer.from('PNGDATA').toString('base64');
  const { checker, rec } = makeInvoker({
    ctx: { inputs: {}, statusUrl: 'http://echo-app:3000/status/req-1', externalRequestId: 'req-1', status: 'running' },
    fetchImpl: async () => jsonResponse(200, {
      status: 'COMPLETED',
      outputs: 'see attached',
      artifacts: [{ contents: pngB64, display_name: 'report.pdf' }],
    }),
  });
  const res = await checker(message, job);
  assert.equal(res.done, true);
  assert.equal(res.status, 'success');
  assert.equal(rec.puts.length, 1);
  const outputs = res.outputs as { outputs: string; artifacts: { displayName: string; s3Url: string }[] };
  assert.equal(outputs.outputs, 'see attached');
  assert.equal(outputs.artifacts[0]?.displayName, 'report.pdf');
  assert.match(outputs.artifacts[0]?.s3Url ?? '', /^s3:\/\/artifacts\/u1\/a1\//);
});

test('large outputs are offloaded above threshold', async () => {
  const big = 'x'.repeat(50);
  const { checker, rec } = makeInvoker({
    ctx: freshCtx(),
    config: { artifactThresholdBytes: 10 },
    fetchImpl: async () => jsonResponse(200, { outputs: big }),
  });
  const res = await checker(message, job);
  assert.equal(rec.puts.length, 1);
  assert.match(rec.puts[0]?.key ?? '', /outputs\.txt$/);
  const outputs = res.outputs as { outputs: string; artifacts: { displayName: string }[] };
  assert.equal(outputs.outputs, '');
  assert.equal(outputs.artifacts[0]?.displayName, 'outputs.txt');
});

test('history not found returns error', async () => {
  const { checker } = makeInvoker({ ctx: null, fetchImpl: async () => jsonResponse(200, {}) });
  const res = await checker(message, job);
  assert.equal(res.status, 'error');
  assert.equal(res.done, true);
});

test('endpoint not configured returns error', async () => {
  const { checker } = makeInvoker({ ctx: freshCtx(), endpoint: null, fetchImpl: async () => jsonResponse(200, {}) });
  assert.equal((await checker(message, job)).status, 'error');
});

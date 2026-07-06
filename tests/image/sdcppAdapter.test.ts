import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isImageError } from '../../src/image/errors.js';
import { createSdcppAdapter } from '../../src/image/adapters/sdcppAdapter.js';
import type { ImageGenRequest } from '../../src/image/types.js';

const noopSleep = async () => {};

function adapter(fetchImpl: typeof fetch, timeoutMs = 10_000) {
  return createSdcppAdapter({
    baseURL: 'http://sdcpp:8080/',
    timeoutMs,
    pollIntervalMs: 0,
    fetch: fetchImpl,
    sleep: noopSleep,
  });
}

const baseReq: ImageGenRequest = {
  model: 'sd15',
  mode: 'txt2img',
  prompt: 'a cat',
  negativePrompt: 'blurry',
  width: 512,
  height: 512,
  steps: 20,
  cfgScale: 7,
  seed: 42,
};

/** 順に応答を返す scripted fetch。各要素は [status, jsonBody]。リクエストは captured に記録。 */
function scriptedFetch(steps: Array<[number, unknown]>, captured: { url: string; body?: string }[]) {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const [status, body] = step ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

test('img_gen→poll→completed で b64_json を返す', async () => {
  const captured: { url: string; body?: string }[] = [];
  const fetchImpl = scriptedFetch(
    [
      [202, { id: 'job1', status: 'queued', poll_url: '/sdcpp/v1/jobs/job1' }],
      [200, { id: 'job1', status: 'generating' }],
      [200, { id: 'job1', status: 'completed', result: { output_format: 'png', images: [{ index: 0, b64_json: 'IMGB64' }] } }],
    ],
    captured,
  );
  const out = await adapter(fetchImpl).generate(baseReq);
  assert.equal(out, 'IMGB64');

  // POST は img_gen へ・wire 写像（cfg→sample_params.guidance.txt_cfg、steps→sample_steps）。
  assert.match(captured[0]?.url ?? '', /\/sdcpp\/v1\/img_gen$/);
  const sent = JSON.parse(captured[0]?.body ?? '{}');
  assert.equal(sent.prompt, 'a cat');
  assert.equal(sent.negative_prompt, 'blurry');
  assert.equal(sent.seed, 42);
  assert.equal(sent.sample_params.sample_steps, 20);
  assert.equal(sent.sample_params.guidance.txt_cfg, 7);
  // poll は jobs/{id} へ。
  assert.match(captured[1]?.url ?? '', /\/sdcpp\/v1\/jobs\/job1$/);
});

test('img2img/inpaint/controlnet のフィールドが wire に乗る', async () => {
  const captured: { url: string; body?: string }[] = [];
  const fetchImpl = scriptedFetch(
    [
      [202, { id: 'j', status: 'queued' }],
      [200, { id: 'j', status: 'completed', result: { images: [{ b64_json: 'X' }] } }],
    ],
    captured,
  );
  await adapter(fetchImpl).generate({
    model: 'sd15',
    mode: 'inpaint',
    prompt: 'p',
    initImage: 'INIT',
    maskImage: 'MASK',
    strength: 0.5,
    controlImage: 'CTRL',
    controlStrength: 0.7,
  });
  const sent = JSON.parse(captured[0]?.body ?? '{}');
  assert.equal(sent.init_image, 'INIT');
  assert.equal(sent.mask_image, 'MASK');
  assert.equal(sent.strength, 0.5);
  assert.equal(sent.control_image, 'CTRL');
  assert.equal(sent.control_strength, 0.7);
});

test('failed ジョブは GENERATION_FAILED', async () => {
  const fetchImpl = scriptedFetch(
    [
      [202, { id: 'j', status: 'queued' }],
      [200, { id: 'j', status: 'failed', error: 'oom' }],
    ],
    [],
  );
  await assert.rejects(
    () => adapter(fetchImpl).generate(baseReq),
    (e) => isImageError(e) && e.code === 'GENERATION_FAILED',
  );
});

test('完了しない場合 TIMEOUT＋job cancel を発行', async () => {
  const captured: { url: string; body?: string }[] = [];
  const fetchImpl = scriptedFetch(
    [
      [202, { id: 'j', status: 'queued' }],
      [200, { id: 'j', status: 'generating' }],
    ],
    captured,
  );
  await assert.rejects(
    () => adapter(fetchImpl, 0).generate(baseReq),
    (e) => isImageError(e) && e.code === 'TIMEOUT',
  );
  // 滞留防止：タイムアウト時に cancel エンドポイントを叩く。
  assert.ok(captured.some((c) => /\/sdcpp\/v1\/jobs\/j\/cancel$/.test(c.url)));
});

test('接続失敗は NETWORK', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => adapter(fetchImpl).generate(baseReq),
    (e) => isImageError(e) && e.code === 'NETWORK',
  );
});

test('img_gen 400 は INVALID_REQUEST', async () => {
  const fetchImpl = scriptedFetch([[400, { error: 'bad' }]], []);
  await assert.rejects(
    () => adapter(fetchImpl).generate(baseReq),
    (e) => isImageError(e) && e.code === 'INVALID_REQUEST',
  );
});

test('img_gen 404 は MODEL_NOT_LOADED', async () => {
  const fetchImpl = scriptedFetch([[404, { error: 'no model' }]], []);
  await assert.rejects(
    () => adapter(fetchImpl).generate(baseReq),
    (e) => isImageError(e) && e.code === 'MODEL_NOT_LOADED',
  );
});

test('img_gen 応答に id が無いと INTERNAL', async () => {
  const fetchImpl = scriptedFetch([[202, { status: 'queued' }]], []);
  await assert.rejects(
    () => adapter(fetchImpl).generate(baseReq),
    (e) => isImageError(e) && e.code === 'INTERNAL',
  );
});

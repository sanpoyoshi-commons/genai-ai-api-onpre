import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { ImageError } from '../../src/image/errors.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { ImageClient, ImageGenerateInput } from '../../src/lib/image/imageClient.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createImageRouter } from '../../src/routes/image/index.js';

let lastInput: ImageGenerateInput | null = null;
let nextError: Error | null = null;
const fakeImage: ImageClient = {
  async generateImage(input) {
    lastInput = input;
    if (nextError) {
      throw nextError;
    }
    return 'BASE64IMAGE';
  },
};

let server: Server | undefined;
let baseUrl: string;
let currentAuth: AuthContext;

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use('/api', createImageRouter({ image: fakeImage }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server?.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => server?.close());

beforeEach(() => {
  lastInput = null;
  nextError = null;
  delete process.env.IMAGE_GENERATION_MODEL_IDS;
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

test('generateImage: base64 を返し params を seam へ渡す', async () => {
  const res = await api('/image/generate', {
    method: 'POST',
    body: JSON.stringify({ params: { textPrompt: [{ text: 'cat', weight: 1 }] } }),
  });
  assert.equal(res.status, 200);
  assert.equal(await res.json(), 'BASE64IMAGE');
  assert.deepEqual(lastInput?.params, { textPrompt: [{ text: 'cat', weight: 1 }] });
});

test('generateImage: 許可リスト外モデルは 400', async () => {
  process.env.IMAGE_GENERATION_MODEL_IDS = JSON.stringify(['allowed-image']);
  const res = await api('/image/generate', {
    method: 'POST',
    body: JSON.stringify({ model: { modelId: 'forbidden' }, params: {} }),
  });
  assert.equal(res.status, 400);
});

test('generateImage: 未対応モード（ImageError MODE_NOT_SUPPORTED）は 501', async () => {
  nextError = new ImageError({ code: 'MODE_NOT_SUPPORTED', backend: 'sdcpp', message: 'unsupported' });
  const res = await api('/image/generate', {
    method: 'POST',
    body: JSON.stringify({ params: { textPrompt: [{ text: 'cat', weight: 1 }] } }),
  });
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: 'unsupported' });
});

test('generateImage: バックエンド障害（ImageError TIMEOUT）は 502', async () => {
  nextError = new ImageError({ code: 'TIMEOUT', backend: 'sdcpp', message: 'too slow' });
  const res = await api('/image/generate', {
    method: 'POST',
    body: JSON.stringify({ params: { textPrompt: [{ text: 'cat', weight: 1 }] } }),
  });
  assert.equal(res.status, 502);
});

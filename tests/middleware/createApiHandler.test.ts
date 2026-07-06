import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { createApiHandler, errorHandler } from '../../src/lib/http/createApiHandler.js';
import { badRequest } from '../../src/lib/http/errors.js';
import { parseBody } from '../../src/lib/http/validation.js';
import { requestContext } from '../../src/middleware/requestContext.js';

let server: Server;
let baseUrl: string;

const bodySchema = z.object({ name: z.string() });

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  // requireAuth の代わりにテスト用 auth を注入（createApiHandler は req.auth を要求する）。
  app.use((req, _res, next) => {
    req.auth = { userId: 'tester', groups: [], claims: {} };
    next();
  });

  const router = express.Router();
  router.get('/ok', createApiHandler(async () => ({ status: 200, body: { ok: true } })));
  router.get('/created', createApiHandler(async () => ({ status: 201 })));
  router.get('/bad', createApiHandler(async () => { throw badRequest('invalid thing'); }));
  router.post('/zod', createApiHandler(async ({ req }) => {
    const parsed = parseBody(bodySchema, req.body);
    return { status: 200, body: parsed };
  }));
  router.get('/boom', createApiHandler(async () => { throw new Error('kaboom internal detail'); }));
  app.use(router);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
});

test('正常系は status と body を JSON 整形する', async () => {
  const res = await fetch(`${baseUrl}/ok`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), { ok: true });
});

test('body 省略時は空 JSON を返す', async () => {
  const res = await fetch(`${baseUrl}/created`);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), {});
});

test('ApiError は status + {error:message} に整形（B-3 分岐1）', async () => {
  const res = await fetch(`${baseUrl}/bad`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid thing' });
});

test('未捕捉エラーは 500 固定文（内部詳細を漏らさない、B-3 分岐2）', async () => {
  const res = await fetch(`${baseUrl}/boom`);
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'Internal Server Error');
  assert.doesNotMatch(body.error, /kaboom/);
});

test('zod 検証エラーは 400', async () => {
  const res = await fetch(`${baseUrl}/zod`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});

test('zod 検証通過は 200 とパース済み body', async () => {
  const res = await fetch(`${baseUrl}/zod`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'genai' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'genai' });
});

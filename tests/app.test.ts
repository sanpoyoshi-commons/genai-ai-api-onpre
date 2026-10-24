import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { createApp } from '../src/app.js';

let server: Server;
let baseUrl: string;

before(async () => {
  // 本文の解析結果をそのまま返すルート。/api のゲートは素通しにする。
  const apiRouter = express.Router();
  apiRouter.post('/echo', (req, res) => {
    res.status(200).json({ body: req.body });
  });
  const app = createApp({ apiGate: (_req, _res, next) => next(), apiRouter });
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

test('Content-Encoding: gzip の JSON 本文は展開せずに拒む（プロセスは生きたまま）', async () => {
  const res = await fetch(`${baseUrl}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: gzipSync(JSON.stringify({ a: 1 })),
  });
  // 展開して解析まで進むと、ルートが無いので 404 になる。その手前で拒まれていること。
  assert.notEqual(res.status, 200);
  assert.notEqual(res.status, 404);
  await res.arrayBuffer();

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
});

test('符号化の無い JSON 本文は今までどおり解析される', async () => {
  const res = await fetch(`${baseUrl}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { body: { a: 1 } });
});

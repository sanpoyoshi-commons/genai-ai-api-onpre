import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';

let server: Server;
let baseUrl: string;

before(async () => {
  const app = createApp();
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

test('GET /health は 200 と status:ok の JSON を返す', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);

  const body = (await res.json()) as { status: string; service: string; timestamp: string };
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'genai-ai-api-onpre');
  assert.equal(typeof body.timestamp, 'string');
});

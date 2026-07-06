import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { SystemContextRecord } from '../../src/lib/serialize/systemContext.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import type { SystemContextsDeps } from '../../src/routes/systemContexts/deps.js';
import { createSystemContextsRouter } from '../../src/routes/systemContexts/index.js';

// ── ステートフル fake repository（本人スコープ再現） ──
const store = new Map<string, SystemContextRecord>();
let seq = 0;

const fakeSystemContexts = {
  async create(userId: string, title: string, systemContext: string): Promise<SystemContextRecord> {
    const rec: SystemContextRecord = { id: `s${++seq}`, userId, title, systemContext, createdDate: new Date() };
    store.set(rec.id, rec);
    return rec;
  },
  async findById(userId: string, id: string): Promise<SystemContextRecord | null> {
    const rec = store.get(id);
    return rec && rec.userId === userId ? rec : null;
  },
  async listByUser(userId: string): Promise<SystemContextRecord[]> {
    return [...store.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdDate.getTime() - a.createdDate.getTime());
  },
  async setTitle(id: string, title: string): Promise<SystemContextRecord> {
    const rec = store.get(id);
    if (!rec) {
      throw new Error('not found');
    }
    rec.title = title;
    return rec;
  },
  async delete(id: string): Promise<void> {
    store.delete(id);
  },
};

const deps = { systemContexts: fakeSystemContexts } as unknown as SystemContextsDeps;

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { userId: 'user-1', groups: [], claims: {} };
    next();
  });
  app.use('/api', createSystemContextsRouter(deps));
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

beforeEach(() => {
  store.clear();
  seq = 0;
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

test('POST /systemcontexts は { messages } キーで源内型を返す', async () => {
  const body = JSON.stringify({ systemContextTitle: '要約', systemContext: 'あなたは要約者です' });
  const res = await api('/systemcontexts', { method: 'POST', body });
  assert.equal(res.status, 200);
  const { messages } = (await res.json()) as { messages: Record<string, string> };
  assert.equal(messages.id, 'systemContext#user-1');
  assert.match(messages.systemContextId, /^systemContext#/);
  assert.equal(messages.systemContextTitle, '要約');
  assert.equal(messages.systemContext, 'あなたは要約者です');
});

test('POST /systemcontexts は必須欠落で 400（zod）', async () => {
  const res = await api('/systemcontexts', { method: 'POST', body: JSON.stringify({ systemContextTitle: 'x' }) });
  assert.equal(res.status, 400);
});

test('GET /systemcontexts は本人の一覧を配列で直返し', async () => {
  await fakeSystemContexts.create('user-1', 't1', 'c1');
  await fakeSystemContexts.create('user-2', 't2', 'c2'); // 他人
  const res = await api('/systemcontexts');
  assert.equal(res.status, 200);
  const items = (await res.json()) as { id: string }[];
  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'systemContext#user-1');
});

test('PUT /systemcontexts/:id/title は本人のタイトルを更新', async () => {
  const s = await fakeSystemContexts.create('user-1', '旧', 'c');
  const res = await api(`/systemcontexts/${s.id}/title`, { method: 'PUT', body: JSON.stringify({ title: '新' }) });
  assert.equal(res.status, 200);
  const { systemContext } = (await res.json()) as { systemContext: { systemContextTitle: string } };
  assert.equal(systemContext.systemContextTitle, '新');
});

test('PUT /systemcontexts/:id/title は不在で 404', async () => {
  const res = await api('/systemcontexts/missing/title', { method: 'PUT', body: JSON.stringify({ title: 'x' }) });
  assert.equal(res.status, 404);
});

test('PUT /systemcontexts/:id/title は他人の所有で 404（本人スコープ）', async () => {
  const s = await fakeSystemContexts.create('user-2', 't', 'c');
  const res = await api(`/systemcontexts/${s.id}/title`, { method: 'PUT', body: JSON.stringify({ title: 'x' }) });
  assert.equal(res.status, 404);
});

test('DELETE /systemcontexts/:id は 204（冪等）', async () => {
  const s = await fakeSystemContexts.create('user-1', 't', 'c');
  const res = await api(`/systemcontexts/${s.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(store.has(s.id), false);

  const again = await api(`/systemcontexts/${s.id}`, { method: 'DELETE' });
  assert.equal(again.status, 204);
});

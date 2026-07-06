import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { ChatRecord, MessageRecord } from '../../src/lib/serialize/chat.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import type { ChatsDeps } from '../../src/routes/chats/deps.js';
import { createChatsRouter } from '../../src/routes/chats/index.js';
import type { ToBeRecordedMessage } from '../../src/types/genaiWeb.js';

// ── ステートフル fake repository（DB 非依存・本人スコープを再現） ──
const chatStore = new Map<string, ChatRecord>();
const messageStore: MessageRecord[] = [];
let seq = 0;

const fakeChats = {
  async create(userId: string): Promise<ChatRecord> {
    const now = new Date();
    const rec: ChatRecord = { chatId: `c${++seq}`, userId, title: null, createdDate: now, updatedDate: now };
    chatStore.set(rec.chatId, rec);
    return rec;
  },
  async findById(userId: string, chatId: string): Promise<ChatRecord | null> {
    const rec = chatStore.get(chatId);
    return rec && rec.userId === userId ? rec : null;
  },
  async listByUser(userId: string): Promise<{ data: ChatRecord[]; nextCursor?: string }> {
    const data = [...chatStore.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.createdDate.getTime() - a.createdDate.getTime());
    return { data, nextCursor: undefined };
  },
  async setTitle(chatId: string, title: string): Promise<ChatRecord> {
    const rec = chatStore.get(chatId);
    if (!rec) {
      throw new Error('not found');
    }
    rec.title = title;
    rec.updatedDate = new Date();
    return rec;
  },
  async delete(chatId: string): Promise<void> {
    chatStore.delete(chatId);
  },
};

const fakeMessages = {
  async listByChat(chatId: string): Promise<MessageRecord[]> {
    return messageStore.filter((m) => m.chatId === chatId);
  },
  async batchCreate(inputs: ToBeRecordedMessage[], userId: string, chatId: string): Promise<MessageRecord[]> {
    const now = Date.now();
    const rows = inputs.map((m, i) => ({
      chatId,
      createdDate: m.createdDate ?? `${now + i}#0`,
      userId,
      role: m.role,
      content: { content: m.content, messageId: m.messageId, usecase: m.usecase, trace: m.trace, extraData: m.extraData },
      feedback: 'none',
      llmType: m.llmType ?? '',
    }));
    messageStore.push(...rows);
    return rows;
  },
};

const deps = { chats: fakeChats, messages: fakeMessages } as unknown as ChatsDeps;

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
  app.use('/api', createChatsRouter(deps));
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
  chatStore.clear();
  messageStore.length = 0;
  seq = 0;
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

test('POST /chats は源内 Chat 型（user#/chat# プレフィックス）で 200 を返す', async () => {
  const res = await api('/chats', { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
  const { chat } = (await res.json()) as { chat: Record<string, string> };
  assert.equal(chat.id, 'user#user-1');
  assert.match(chat.chatId, /^chat#/);
  assert.equal(chat.usecase, '');
  assert.equal(chat.title, '');
  assert.match(chat.createdDate, /^\d+$/); // ms 文字列
});

test('GET /chats は本人のチャットのみ（新しい順）を data で返す', async () => {
  await fakeChats.create('user-1');
  await fakeChats.create('user-2'); // 他人
  const res = await api('/chats');
  assert.equal(res.status, 200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  assert.equal(data.length, 1);
  assert.equal(data[0]?.id, 'user#user-1');
});

test('GET /chats/:chatId は本人の chat を返す', async () => {
  const c = await fakeChats.create('user-1');
  const res = await api(`/chats/${c.chatId}`);
  assert.equal(res.status, 200);
  const { chat } = (await res.json()) as { chat: { chatId: string } | null };
  assert.equal(chat?.chatId, `chat#${c.chatId}`);
});

test('GET /chats/:chatId は他人の chat には { chat: null }', async () => {
  const c = await fakeChats.create('user-2');
  const res = await api(`/chats/${c.chatId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { chat: null });
});

test('PUT /chats/:chatId/title は本人の chat のタイトルを更新', async () => {
  const c = await fakeChats.create('user-1');
  const res = await api(`/chats/${c.chatId}/title`, { method: 'PUT', body: JSON.stringify({ title: '新題' }) });
  assert.equal(res.status, 200);
  const { chat } = (await res.json()) as { chat: { title: string } };
  assert.equal(chat.title, '新題');
});

test('PUT /chats/:chatId/title は不在で 404', async () => {
  const res = await api('/chats/missing/title', { method: 'PUT', body: JSON.stringify({ title: 'x' }) });
  assert.equal(res.status, 404);
});

test('PUT /chats/:chatId/title は空タイトルで 400（zod）', async () => {
  const c = await fakeChats.create('user-1');
  const res = await api(`/chats/${c.chatId}/title`, { method: 'PUT', body: JSON.stringify({ title: '  ' }) });
  assert.equal(res.status, 400);
});

test('DELETE /chats/:chatId は 204（冪等）', async () => {
  const c = await fakeChats.create('user-1');
  const res = await api(`/chats/${c.chatId}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(chatStore.has(c.chatId), false);

  const again = await api(`/chats/${c.chatId}`, { method: 'DELETE' });
  assert.equal(again.status, 204);
});

test('GET /chats/:chatId/messages は他人の chat で 403', async () => {
  const c = await fakeChats.create('user-2');
  const res = await api(`/chats/${c.chatId}/messages`);
  assert.equal(res.status, 403);
});

test('POST /chats/:chatId/messages は本人 chat へ作成し RecordedMessage を返す', async () => {
  const c = await fakeChats.create('user-1');
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'こんにちは', messageId: 'm1', usecase: 'chat' }],
  });
  const res = await api(`/chats/${c.chatId}/messages`, { method: 'POST', body });
  assert.equal(res.status, 200);
  const { messages } = (await res.json()) as { messages: Record<string, unknown>[] };
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, `chat#${c.chatId}`);
  assert.equal(messages[0]?.content, 'こんにちは');
  assert.equal(messages[0]?.messageId, 'm1');
  assert.equal(messages[0]?.feedback, 'none');
});

test('POST /chats/:chatId/messages は他人 chat で 403', async () => {
  const c = await fakeChats.create('user-2');
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'x', messageId: 'm1', usecase: 'chat' }] });
  const res = await api(`/chats/${c.chatId}/messages`, { method: 'POST', body });
  assert.equal(res.status, 403);
});

test('POST /chats/:chatId/messages は s3 extraData をストレージ未配線時に 400', async () => {
  const c = await fakeChats.create('user-1');
  const body = JSON.stringify({
    messages: [
      {
        role: 'user',
        content: 'x',
        messageId: 'm1',
        usecase: 'chat',
        extraData: [{ type: 'file', name: 'a.pdf', source: { type: 's3', mediaType: 'application/pdf', data: 'https://x/a' } }],
      },
    ],
  });
  const res = await api(`/chats/${c.chatId}/messages`, { method: 'POST', body });
  assert.equal(res.status, 400);
});

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { ChatRecord } from '../../src/lib/serialize/chat.js';
import type { LlmClient, LlmGenerateInput } from '../../src/lib/llm/llmClient.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createPredictRouter } from '../../src/routes/predict/index.js';

// ── fake LLM seam（generate は固定応答、generateStream はトークン列を yield） ──
let llmResponse = '';
let streamTokens: string[] = [];
let streamThrows: Error | null = null;
const fakeLlm: LlmClient = {
  async generate(_input: LlmGenerateInput): Promise<string> {
    return llmResponse;
  },
  async *generateStream(_input: LlmGenerateInput): AsyncIterable<string> {
    if (streamThrows) {
      throw streamThrows;
    }
    for (const t of streamTokens) {
      yield t;
    }
  },
};

// ── fake chats（本人の chat のみ findById で返す。setTitle は記録） ──
const chats = new Map<string, ChatRecord>();
let setTitleCalls: Array<{ chatId: string; title: string }> = [];
const now = () => new Date('2026-05-27T00:00:00Z');
const fakeChats = {
  async findById(userId: string, chatId: string): Promise<ChatRecord | null> {
    const c = chats.get(chatId);
    return c && c.userId === userId ? c : null;
  },
  async setTitle(chatId: string, title: string): Promise<ChatRecord> {
    setTitleCalls.push({ chatId, title });
    const c = chats.get(chatId);
    if (!c) throw new Error('not found');
    c.title = title;
    return c;
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
  app.use('/api', createPredictRouter({ llm: fakeLlm, chats: fakeChats }));
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
  chats.clear();
  setTitleCalls = [];
  llmResponse = '';
  streamTokens = [];
  streamThrows = null;
  delete process.env.MODEL_IDS;
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

test('predict: 生成テキストを JSON 文字列で返す', async () => {
  llmResponse = 'こんにちは';
  const res = await api('/predict', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], id: 'r1' }),
  });
  assert.equal(res.status, 200);
  assert.equal(await res.json(), 'こんにちは');
});

test('predict: 許可リスト外モデルは 400', async () => {
  process.env.MODEL_IDS = JSON.stringify(['allowed-model']);
  const res = await api('/predict', {
    method: 'POST',
    body: JSON.stringify({ model: { modelId: 'forbidden' }, messages: [], id: 'r1' }),
  });
  assert.equal(res.status, 400);
});

test('predictTitle: <output> を除去し本人 chat へ書き戻す', async () => {
  chats.set('c1', { chatId: 'c1', userId: 'u1', title: null, createdDate: now(), updatedDate: now() });
  llmResponse = '<output>会議の議事録</output>';
  const res = await api('/predict/title', {
    method: 'POST',
    body: JSON.stringify({ chat: { chatId: 'chat#c1', createdDate: '1700000000000' }, prompt: 'p', id: 'r1' }),
  });
  assert.equal(res.status, 200);
  assert.equal(await res.json(), '会議の議事録');
  assert.deepEqual(setTitleCalls, [{ chatId: 'c1', title: '会議の議事録' }]);
});

test('predictTitle: 他人の chat は 404・書き戻さない', async () => {
  chats.set('c1', { chatId: 'c1', userId: 'owner', title: null, createdDate: now(), updatedDate: now() });
  const res = await api('/predict/title', {
    method: 'POST',
    body: JSON.stringify({ chat: { chatId: 'chat#c1', createdDate: '1700000000000' }, prompt: 'p', id: 'r1' }),
  });
  assert.equal(res.status, 404);
  assert.equal(setTitleCalls.length, 0);
});

test('predictStream: トークンを JSONL（chunked）で流す', async () => {
  streamTokens = ['あ', 'い', 'う'];
  const res = await api('/predict/stream', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], id: 'r1' }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ text: 'あ' }, { text: 'い' }, { text: 'う' }]);
});

test('predictStream: モデル不許可は error チャンクで 200 終了', async () => {
  process.env.MODEL_IDS = JSON.stringify(['allowed-model']);
  const res = await api('/predict/stream', {
    method: 'POST',
    body: JSON.stringify({ model: { modelId: 'forbidden' }, messages: [], id: 'r1' }),
  });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].stopReason, 'error');
});

test('predictStream: ストリーム開始後の例外は error チャンクで閉じる', async () => {
  streamThrows = new Error('backend down');
  const res = await api('/predict/stream', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], id: 'r1' }),
  });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[lines.length - 1].stopReason, 'error');
});

import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../../src/lib/auth/context.js';
import { USER_GROUP } from '../../../src/lib/auth/groups.js';
import { errorHandler } from '../../../src/lib/http/createApiHandler.js';
import type { JudgeConfig } from '../../../src/lib/judge/config.js';
import { JudgeService } from '../../../src/lib/judge/judgeService.js';
import { OllamaNativeClient } from '../../../src/lib/judge/ollamaNativeClient.js';
import { requestContext } from '../../../src/middleware/requestContext.js';
import { createJudgeRouter } from '../../../src/routes/judge/index.js';

/**
 * 時間制御の経路テスト（上流は「応答しない HTTP サーバ」で再現）。
 * 素の fetch ＋ AbortSignal の実挙動（abort 理由がそのまま throw される）を含めて確認する。
 */

/** 応答しない上流 Ollama 役。 */
let upstream: Server | undefined;
let upstreamUrl = '';
let upstreamRequests = 0;
let upstreamClosed = 0;

let server: Server | undefined;
let baseUrl = '';

const config = (overrides: Partial<JudgeConfig> = {}): JudgeConfig => ({
  baseUrl: upstreamUrl,
  defaultModel: 'gemma4:e2b',
  allowedModels: ['gemma4:e2b'],
  contextLength: 8192,
  maxStateBytes: 8192,
  attemptTimeoutMs: 150,
  requestBudgetMs: 5000,
  maxRetryWaitMs: 60000,
  ...overrides,
});

const auth: AuthContext = { userId: 'u1', groups: [USER_GROUP], claims: {} };

before(async () => {
  upstream = http.createServer((req) => {
    upstreamRequests += 1;
    req.on('close', () => {
      upstreamClosed += 1;
    });
    // 応答は返さない（プレフィル中に固まった上流の再現）。
  });
  await new Promise<void>((resolve) => {
    upstream?.listen(0, () => {
      const addr = upstream?.address();
      upstreamUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });

  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = auth;
    next();
  });
  app.use('/api', (req, res, next) => {
    const cfg = config();
    const client = new OllamaNativeClient({
      baseUrl: cfg.baseUrl,
      attemptTimeoutMs: cfg.attemptTimeoutMs,
      maxRetryWaitMs: cfg.maxRetryWaitMs,
      maxRetries: 0, // 再試行は client 単体テストで見るので、ここは 1 回で落とす
      sleep: async () => undefined,
    });
    createJudgeRouter({ judge: new JudgeService(client, cfg) })(req, res, next);
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server?.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  upstream?.close();
});

const body = JSON.stringify({ state: 'x', questions: { q: { type: 'noul', instructions: 'q' } } });

test('応答しない上流は per-attempt タイムアウトで 504 になる', async () => {
  const res = await fetch(`${baseUrl}/api/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: '判定モデルが時間内に応答しませんでした' });
});

test('呼び出し側が切ると上流への接続も切れ、再試行は起きない', async () => {
  const before = { requests: upstreamRequests, closed: upstreamClosed };
  const controller = new AbortController();
  const pending = fetch(`${baseUrl}/api/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50); // per-attempt タイムアウト（150ms）より前に切る
  await assert.rejects(() => pending);

  // 上流側が切断を観測するまで少し待つ。
  for (let i = 0; i < 50 && upstreamClosed === before.closed; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(upstreamRequests - before.requests, 1, '中断は再試行しない');
  assert.equal(upstreamClosed - before.closed, 1, '上流への接続も切られる');
});

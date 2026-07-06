import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import { decodeJobMessage } from '../../src/lib/exapp/jobMessage.js';
import type { CreateHistoryInput, HistoryKey } from '../../src/repositories/invokeHistoryRepository.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createInvokeExAppHandler } from '../../src/routes/exApps/invokeExApp.js';

let server: Server;
let baseUrl: string;

// 注入する fake の記録（テストごとに参照する）。
const enqueued: string[] = [];
const createdHistories: CreateHistoryInput[] = [];
const CREATED_DATE = new Date('2026-05-26T12:34:56.000Z');

// 認可・存在の分岐を切り替えるフラグ。
let membership: { isAdmin: boolean } | null = { isAdmin: false };
let snapshot: { exAppName: string; teamName: string } | null = { exAppName: 'App One', teamName: 'Team One' };

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { userId: 'user-1', groups: [], claims: {} };
    next();
  });

  const handler = createInvokeExAppHandler({
    queue: {
      async enqueueJob(body: string) {
        enqueued.push(body);
      },
    } as never,
    exApps: {
      async findSnapshotById() {
        return snapshot;
      },
    },
    histories: {
      async create(input: CreateHistoryInput): Promise<HistoryKey> {
        createdHistories.push(input);
        return { teamId: input.teamId, exAppId: input.exAppId, userId: input.userId, createdDate: CREATED_DATE };
      },
    },
    teamUsers: {
      async findMembership() {
        return membership;
      },
    },
  });

  const router = express.Router();
  router.post('/exapps/invoke', handler);
  app.use('/api', router);
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

function reset() {
  enqueued.length = 0;
  createdHistories.length = 0;
  membership = { isAdmin: false };
  snapshot = { exAppName: 'App One', teamName: 'Team One' };
}

async function invoke(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/exapps/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('メンバーは 202 を受け、履歴作成とキュー投入が起こる', async () => {
  reset();
  const res = await invoke({ teamId: 'team-1', exAppId: 'app-1', inputs: { prompt: 'hi' } });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: 'accepted' });

  assert.equal(createdHistories.length, 1);
  const history = createdHistories[0];
  assert.equal(history?.teamNameSnapshot, 'Team One');
  assert.equal(history?.exAppNameSnapshot, 'App One');
  assert.deepEqual(history?.inputs, { prompt: 'hi' });

  // キュー body には履歴の複合キー（createdDate は ISO）が載る。
  assert.equal(enqueued.length, 1);
  assert.deepEqual(decodeJobMessage(enqueued[0] ?? ''), {
    teamId: 'team-1',
    exAppId: 'app-1',
    userId: 'user-1',
    createdDate: CREATED_DATE.toISOString(),
  });
});

test('inputs 省略時は空オブジェクトで履歴作成', async () => {
  reset();
  const res = await invoke({ teamId: 'team-1', exAppId: 'app-1' });
  assert.equal(res.status, 202);
  assert.deepEqual(createdHistories[0]?.inputs, {});
});

test('非メンバーは 403（履歴作成・投入なし）', async () => {
  reset();
  membership = null;
  const res = await invoke({ teamId: 'team-1', exAppId: 'app-1', inputs: {} });
  assert.equal(res.status, 403);
  assert.equal(createdHistories.length, 0);
  assert.equal(enqueued.length, 0);
});

test('存在しないアプリは 404（投入なし）', async () => {
  reset();
  snapshot = null;
  const res = await invoke({ teamId: 'team-1', exAppId: 'missing', inputs: {} });
  assert.equal(res.status, 404);
  assert.equal(enqueued.length, 0);
});

test('必須フィールド欠落は 400（zod）', async () => {
  reset();
  const res = await invoke({ exAppId: 'app-1' });
  assert.equal(res.status, 400);
  assert.equal(createdHistories.length, 0);
});

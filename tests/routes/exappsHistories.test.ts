import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { ExAppRecord, TeamRecord } from '../../src/lib/serialize/team.js';
import { COMMON_TEAM_ID } from '../../src/lib/teams/constants.js';
import type { HistoryRecord } from '../../src/repositories/invokeHistoryRepository.js';
import type { FileStorage } from '../../src/lib/storage/fileStorage.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createExAppsRouter, type ExAppsDeps } from '../../src/routes/exApps/index.js';
import { createInvokeHistoriesRouter } from '../../src/routes/invokeHistories/index.js';
import type { InvokeHistoriesDeps } from '../../src/routes/invokeHistories/deps.js';

const now = () => new Date('2026-05-27T00:00:00Z');
const teams = new Map<string, TeamRecord>();
const exApps = new Map<string, ExAppRecord>(); // key `${teamId}:${exAppId}`
const memberTeamIds = new Map<string, string[]>(); // userId -> teamIds
let histories: HistoryRecord[] = [];

const exAppRecord = (teamId: string, exAppId: string, name: string): ExAppRecord => ({
  teamId,
  exAppId,
  name,
  description: null,
  config: null,
  createdAt: now(),
  updatedAt: now(),
});

const fakeTeams = {
  async findById(id: string): Promise<TeamRecord | null> {
    return teams.get(id) ?? null;
  },
};
const fakeTeamUsers = {
  async listTeamIdsByUser(userId: string): Promise<string[]> {
    return memberTeamIds.get(userId) ?? [];
  },
};
const fakeExApps = {
  async listByTeam(teamId: string): Promise<{ data: ExAppRecord[]; nextCursor?: string }> {
    return { data: [...exApps.values()].filter((e) => e.teamId === teamId) };
  },
  async findById(teamId: string, exAppId: string): Promise<ExAppRecord | null> {
    return exApps.get(`${teamId}:${exAppId}`) ?? null;
  },
};
const fakeHistories = {
  async listByScope(
    teamId: string,
    exAppId: string,
    userId: string,
  ): Promise<{ data: HistoryRecord[]; nextCursor?: string }> {
    return { data: histories.filter((h) => h.teamId === teamId && h.exAppId === exAppId && h.userId === userId) };
  },
  async findByKey(
    teamId: string,
    exAppId: string,
    userId: string,
    createdDate: string,
  ): Promise<HistoryRecord | null> {
    const at = Number(createdDate);
    return (
      histories.find(
        (h) =>
          h.teamId === teamId &&
          h.exAppId === exAppId &&
          h.userId === userId &&
          h.createdDate.getTime() === at,
      ) ?? null
    );
  },
};
let downloadCalls: Array<{ bucket: string; key: string }> = [];
const fakeStorage: FileStorage = {
  async presignUpload(_bucket, key) {
    return `up/${key}`;
  },
  async presignDownload(bucket, key) {
    downloadCalls.push({ bucket, key });
    return `https://storage.example/${key}`;
  },
  async getObject() {
    return new Uint8Array();
  },
  async deleteObject() {},
};

const exAppsDeps = {
  queue: {},
  teams: fakeTeams,
  teamUsers: fakeTeamUsers,
  exApps: fakeExApps,
  histories: fakeHistories,
} as unknown as ExAppsDeps;

const historiesDeps = {
  teams: fakeTeams,
  exApps: fakeExApps,
  histories: fakeHistories,
  storage: fakeStorage,
  buckets: { artifactsBucket: 'artifacts' },
} as unknown as InvokeHistoriesDeps;

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
  app.use('/api', createExAppsRouter(exAppsDeps));
  app.use('/api', createInvokeHistoriesRouter(historiesDeps));
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
  teams.clear();
  exApps.clear();
  memberTeamIds.clear();
  histories = [];
  downloadCalls = [];
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

test('listExApps: 所属チーム＋共通チームを横断しチーム名を付与', async () => {
  teams.set('tA', { id: 'tA', name: 'チームA', createdAt: now(), updatedAt: now() });
  teams.set(COMMON_TEAM_ID, { id: COMMON_TEAM_ID, name: '共通', createdAt: now(), updatedAt: now() });
  memberTeamIds.set('u1', ['tA']);
  exApps.set('tA:e1', exAppRecord('tA', 'e1', 'アプリ1'));
  exApps.set(`${COMMON_TEAM_ID}:e2`, exAppRecord(COMMON_TEAM_ID, 'e2', '共通アプリ'));

  const res = await api('/exapps');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ exAppName: string; teamName: string }>;
  assert.equal(body.length, 2);
  assert.deepEqual(
    body.map((b) => [b.exAppName, b.teamName]).sort(),
    [
      ['アプリ1', 'チームA'],
      ['共通アプリ', '共通'],
    ],
  );
});

test('listExApps: 所属0でも共通チーム分のみ返す', async () => {
  teams.set(COMMON_TEAM_ID, { id: COMMON_TEAM_ID, name: '共通', createdAt: now(), updatedAt: now() });
  exApps.set(`${COMMON_TEAM_ID}:e2`, exAppRecord(COMMON_TEAM_ID, 'e2', '共通アプリ'));
  const res = await api('/exapps');
  const body = (await res.json()) as unknown[];
  assert.equal(body.length, 1);
});

test('listInvokeExAppHistories: 本人履歴を status 写像して返す', async () => {
  teams.set('tA', { id: 'tA', name: 'A', createdAt: now(), updatedAt: now() });
  exApps.set('tA:e1', exAppRecord('tA', 'e1', 'アプリ1'));
  histories = [
    {
      teamId: 'tA',
      exAppId: 'e1',
      userId: 'u1',
      createdDate: new Date(1700000000000),
      teamNameSnapshot: 'A',
      exAppNameSnapshot: 'アプリ1',
      inputs: { q: 1 },
      outputs: { r: 2 },
      status: 'success',
    },
  ];
  const res = await api('/exapps/histories?teamId=tA&exAppId=e1');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { history: Array<{ status: string; outputs: string; createdDate: string }> };
  assert.equal(body.history[0].status, 'COMPLETED');
  assert.equal(body.history[0].outputs, JSON.stringify({ r: 2 }));
  assert.equal(body.history[0].createdDate, '1700000000000');
});

test('listInvokeExAppHistories: チーム/アプリ不在は 400', async () => {
  const res = await api('/exapps/histories?teamId=missing&exAppId=e1');
  assert.equal(res.status, 400);
});

test('getInvokeExAppHistory: 単件取得・不在は history null', async () => {
  teams.set('tA', { id: 'tA', name: 'A', createdAt: now(), updatedAt: now() });
  exApps.set('tA:e1', exAppRecord('tA', 'e1', 'アプリ1'));
  histories = [
    {
      teamId: 'tA',
      exAppId: 'e1',
      userId: 'u1',
      createdDate: new Date(1700000000000),
      teamNameSnapshot: 'A',
      exAppNameSnapshot: 'アプリ1',
      inputs: {},
      outputs: null,
      status: 'running',
    },
  ];
  const hit = await api('/exapps/history?teamId=tA&exAppId=e1&createdDate=1700000000000');
  const hitBody = (await hit.json()) as { history: { status: string } | null };
  assert.equal(hitBody.history?.status, 'IN_PROGRESS');

  const miss = await api('/exapps/history?teamId=tA&exAppId=e1&createdDate=1699999999999');
  const missBody = (await miss.json()) as { history: unknown };
  assert.equal(missBody.history, null);
});

test('getArtifactFile: 本人アーティファクトは署名 URL、他人/他バケット/不正は拒否', async () => {
  const ownUrl = encodeURIComponent('s3://artifacts/u1/tA/e1/out.bin');
  const ok = await api(`/exapps/artifact-file?s3Url=${ownUrl}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { data: 'https://storage.example/u1/tA/e1/out.bin' });

  const otherOwner = encodeURIComponent('s3://artifacts/u2/tA/e1/out.bin');
  assert.equal((await api(`/exapps/artifact-file?s3Url=${otherOwner}`)).status, 403);

  const otherBucket = encodeURIComponent('s3://secret/u1/out.bin');
  assert.equal((await api(`/exapps/artifact-file?s3Url=${otherBucket}`)).status, 403);

  const bad = encodeURIComponent('not-a-url');
  assert.equal((await api(`/exapps/artifact-file?s3Url=${bad}`)).status, 400);
});

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { SYSTEM_ADMIN_GROUP, TEAM_ADMIN_GROUP, USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { ExAppRecord, TeamRecord, TeamUserRecord } from '../../src/lib/serialize/team.js';
import { COMMON_TEAM_ID } from '../../src/lib/teams/constants.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import type { TeamsDeps } from '../../src/routes/teams/deps.js';
import { createTeamsRouter } from '../../src/routes/teams/index.js';

// ── ステートフル fake（teams 群の認可2層・共通チーム特例・config 封入を再現） ──
const teams = new Map<string, TeamRecord>();
const members = new Map<string, TeamUserRecord>(); // key: `${teamId}:${userId}`
const exApps = new Map<string, ExAppRecord>(); // key: `${teamId}:${exAppId}`
const apiKeyStore = new Map<string, string>(); // key: `${teamId}:${exAppId}`
let idpCalls: Array<{ op: string; userId: string; group?: string; email?: string }> = [];
let idpUsersByEmail = new Map<string, { userId: string; email: string }>();
let seq = 0;
const now = () => new Date('2026-05-26T00:00:00Z');

const fakeTeams = {
  async create(name: string): Promise<TeamRecord> {
    const rec: TeamRecord = { id: `team-${++seq}`, name, createdAt: now(), updatedAt: now() };
    teams.set(rec.id, rec);
    return rec;
  },
  async findById(id: string): Promise<TeamRecord | null> {
    return teams.get(id) ?? null;
  },
  async listAll(): Promise<{ data: TeamRecord[]; nextCursor?: string }> {
    return { data: [...teams.values()] };
  },
  async listAdminScoped(userId: string): Promise<{ data: TeamRecord[]; nextCursor?: string }> {
    const adminTeamIds = [...members.values()].filter((m) => m.userId === userId && m.isAdmin).map((m) => m.teamId);
    return { data: [...teams.values()].filter((t) => adminTeamIds.includes(t.id)) };
  },
  async updateName(id: string, name: string): Promise<TeamRecord> {
    const rec = teams.get(id);
    if (!rec) throw new Error('P2025');
    rec.name = name;
    rec.updatedAt = now();
    return rec;
  },
  async delete(id: string): Promise<void> {
    teams.delete(id);
  },
};

const fakeTeamUsers = {
  async findMembership(teamId: string, userId: string): Promise<{ isAdmin: boolean } | null> {
    const m = members.get(`${teamId}:${userId}`);
    return m ? { isAdmin: m.isAdmin } : null;
  },
  async create(teamId: string, userId: string, username: string, isAdmin: boolean): Promise<TeamUserRecord> {
    const rec: TeamUserRecord = { teamId, userId, username, isAdmin, createdAt: now(), updatedAt: now() };
    members.set(`${teamId}:${userId}`, rec);
    return rec;
  },
  async findById(teamId: string, userId: string): Promise<TeamUserRecord | null> {
    return members.get(`${teamId}:${userId}`) ?? null;
  },
};

const fakeExApps = {
  async create(input: {
    teamId: string;
    exAppName: string;
    endpoint: string;
    config?: string;
    placeholder: string;
    systemPrompt?: string;
    systemPromptKeyName?: string;
    description: string;
    howToUse: string;
    copyable?: boolean;
    status?: 'draft' | 'published';
  }): Promise<ExAppRecord> {
    const exAppId = `app-${++seq}`;
    const rec: ExAppRecord = {
      teamId: input.teamId,
      exAppId,
      name: input.exAppName,
      description: input.description,
      config: {
        endpoint: input.endpoint,
        config: input.config ?? '',
        placeholder: input.placeholder,
        systemPrompt: input.systemPrompt ?? '',
        systemPromptKeyName: input.systemPromptKeyName ?? '',
        howToUse: input.howToUse,
        copyable: input.copyable ?? false,
        status: input.status ?? 'draft',
      },
      createdAt: now(),
      updatedAt: now(),
    };
    exApps.set(`${input.teamId}:${exAppId}`, rec);
    return rec;
  },
  async findById(teamId: string, exAppId: string): Promise<ExAppRecord | null> {
    return exApps.get(`${teamId}:${exAppId}`) ?? null;
  },
  async listByTeam(teamId: string): Promise<{ data: ExAppRecord[]; nextCursor?: string }> {
    return { data: [...exApps.values()].filter((e) => e.teamId === teamId) };
  },
  async listAllIds(teamId: string): Promise<string[]> {
    return [...exApps.values()].filter((e) => e.teamId === teamId).map((e) => e.exAppId);
  },
  // 非対称規則を本番 repository と同等に再現（systemPrompt 系は無条件上書き）。
  async update(
    teamId: string,
    exAppId: string,
    patch: Record<string, unknown>,
  ): Promise<ExAppRecord> {
    const rec = exApps.get(`${teamId}:${exAppId}`);
    if (!rec) throw new Error('update target not found');
    const cur = rec.config as Record<string, unknown>;
    const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    rec.config = {
      endpoint: nonEmpty(patch.endpoint) ? patch.endpoint : cur.endpoint,
      config: nonEmpty(patch.config) ? patch.config : cur.config,
      placeholder: nonEmpty(patch.placeholder) ? patch.placeholder : cur.placeholder,
      howToUse: nonEmpty(patch.howToUse) ? patch.howToUse : cur.howToUse,
      copyable: typeof patch.copyable === 'boolean' ? patch.copyable : cur.copyable,
      status: patch.status === 'draft' || patch.status === 'published' ? patch.status : cur.status,
      systemPrompt: patch.systemPrompt ?? '',
      systemPromptKeyName: patch.systemPromptKeyName ?? '',
    };
    if (nonEmpty(patch.exAppName)) rec.name = patch.exAppName;
    if (nonEmpty(patch.description)) rec.description = patch.description;
    rec.updatedAt = now();
    return rec;
  },
  async delete(teamId: string, exAppId: string): Promise<void> {
    exApps.delete(`${teamId}:${exAppId}`);
  },
};

const fakeHistories = {
  deleted: [] as Array<{ teamId: string; exAppId: string; userId: string; createdDate: string }>,
  async deleteByKey(teamId: string, exAppId: string, userId: string, createdDate: string): Promise<void> {
    this.deleted.push({ teamId, exAppId, userId, createdDate });
  },
};

const fakeIdp = {
  async findUserByEmail(email: string) {
    idpCalls.push({ op: 'find', userId: '', email });
    return idpUsersByEmail.get(email) ?? null;
  },
  async addUserToGroup(userId: string, group: string) {
    idpCalls.push({ op: 'add', userId, group });
  },
  async removeUserFromGroup(userId: string, group: string) {
    idpCalls.push({ op: 'remove', userId, group });
  },
};

const fakeApiKeys = {
  async getApiKey(teamId: string, exAppId: string): Promise<string | null> {
    return apiKeyStore.get(`${teamId}:${exAppId}`) ?? null;
  },
  async setApiKey(teamId: string, exAppId: string, value: string): Promise<void> {
    apiKeyStore.set(`${teamId}:${exAppId}`, value);
  },
  async deleteApiKey(teamId: string, exAppId: string): Promise<void> {
    apiKeyStore.delete(`${teamId}:${exAppId}`);
  },
};

const deps = {
  teams: fakeTeams,
  teamUsers: fakeTeamUsers,
  exApps: fakeExApps,
  histories: fakeHistories,
  idp: fakeIdp,
  apiKeys: fakeApiKeys,
} as unknown as TeamsDeps;

let currentAuth: AuthContext;
let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use('/api', createTeamsRouter(deps));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => server?.close());

beforeEach(() => {
  teams.clear();
  members.clear();
  exApps.clear();
  apiKeyStore.clear();
  idpCalls = [];
  idpUsersByEmail = new Map();
  fakeHistories.deleted = [];
  seq = 0;
  currentAuth = { userId: 'u-sys', groups: [SYSTEM_ADMIN_GROUP], claims: {} };
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

// ── createTeam（#21・SystemAdmin） ──
test('createTeam: 非システム管理者は 403', async () => {
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
  const res = await api('/teams', { method: 'POST', body: JSON.stringify({ teamName: 'T', teamAdminEmail: 'a@e.jp' }) });
  assert.equal(res.status, 403);
});

test('createTeam: IdP 未ログインのメールは 404', async () => {
  const res = await api('/teams', { method: 'POST', body: JSON.stringify({ teamName: 'T', teamAdminEmail: 'x@e.jp' }) });
  assert.equal(res.status, 404);
});

test('createTeam: 正常＝チーム＋初代管理者を作成し TeamAdmin グループへ加入', async () => {
  idpUsersByEmail.set('a@e.jp', { userId: 'u-admin', email: 'a@e.jp' });
  const res = await api('/teams', { method: 'POST', body: JSON.stringify({ teamName: 'チームA', teamAdminEmail: 'a@e.jp' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.teamName, 'チームA');
  assert.equal(body.teamUser.isAdmin, true);
  assert.equal(body.teamUser.userId, 'u-admin');
  assert.ok(idpCalls.some((c) => c.op === 'add' && c.userId === 'u-admin' && c.group === TEAM_ADMIN_GROUP));
});

// ── listTeams（#22・2分岐） ──
test('listTeams: システム管理者は全チーム', async () => {
  await fakeTeams.create('A');
  await fakeTeams.create('B');
  const res = await api('/teams');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.teams.length, 2);
  assert.equal(body.lastEvaluatedKey, null);
});

test('listTeams: 非システム管理者は管理チームのみ・0件は 403', async () => {
  const t = await fakeTeams.create('A');
  await fakeTeams.create('B');
  // u2 は team A の管理者
  members.set(`${t.id}:u2`, { teamId: t.id, userId: 'u2', username: 'u2', isAdmin: true, createdAt: now(), updatedAt: now() });
  currentAuth = { userId: 'u2', groups: [TEAM_ADMIN_GROUP], claims: {} };
  const res = await api('/teams');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.teams.length, 1);

  currentAuth = { userId: 'u3', groups: [TEAM_ADMIN_GROUP], claims: {} };
  const res2 = await api('/teams');
  assert.equal(res2.status, 403);
});

// ── getTeam（#23・共通チーム特例） ──
test('getTeam: 共通チームは認可スキップで取得可', async () => {
  teams.set(COMMON_TEAM_ID, { id: COMMON_TEAM_ID, name: '共通', createdAt: now(), updatedAt: now() });
  currentAuth = { userId: 'u-any', groups: [USER_GROUP], claims: {} };
  const res = await api(`/teams/${COMMON_TEAM_ID}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.teamId, COMMON_TEAM_ID);
});

test('getTeam: 非メンバーは 403、不在は 400', async () => {
  const t = await fakeTeams.create('A');
  currentAuth = { userId: 'u-x', groups: [USER_GROUP], claims: {} };
  assert.equal((await api(`/teams/${t.id}`)).status, 403);

  // sysadmin で不在チーム → 400
  currentAuth = { userId: 'u-sys', groups: [SYSTEM_ADMIN_GROUP], claims: {} };
  assert.equal((await api('/teams/nope')).status, 400);
});

// ── updateTeam（#24） ──
test('updateTeam: チーム管理者が名称更新', async () => {
  const t = await fakeTeams.create('Old');
  members.set(`${t.id}:u2`, { teamId: t.id, userId: 'u2', username: 'u2', isAdmin: true, createdAt: now(), updatedAt: now() });
  currentAuth = { userId: 'u2', groups: [TEAM_ADMIN_GROUP], claims: {} };
  const res = await api(`/teams/${t.id}`, { method: 'PUT', body: JSON.stringify({ teamName: 'New' }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).teamName, 'New');
});

// ── deleteTeam（#25・SystemAdmin only） ──
test('deleteTeam: 非システム管理者は 403', async () => {
  const t = await fakeTeams.create('A');
  members.set(`${t.id}:u2`, { teamId: t.id, userId: 'u2', username: 'u2', isAdmin: true, createdAt: now(), updatedAt: now() });
  currentAuth = { userId: 'u2', groups: [TEAM_ADMIN_GROUP], claims: {} };
  assert.equal((await api(`/teams/${t.id}`, { method: 'DELETE' })).status, 403);
});

test('deleteTeam: システム管理者は配下アプリの apiKey を後始末してから削除', async () => {
  const t = await fakeTeams.create('A');
  await fakeExApps.create({ teamId: t.id, exAppName: 'app', endpoint: 'http://x', placeholder: '', description: '', howToUse: '' });
  apiKeyStore.set(`${t.id}:app-2`, 'secret');
  const res = await api(`/teams/${t.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(teams.has(t.id), false);
  assert.equal(apiKeyStore.has(`${t.id}:app-2`), false);
});

// ── createExApp（#28・config 封入・apiKey 秘匿） ──
test('createExApp: config 封入＋apiKey はストアへ、応答 apiKey は空文字', async () => {
  const t = await fakeTeams.create('A');
  const res = await api(`/teams/${t.id}/exapps`, {
    method: 'POST',
    body: JSON.stringify({
      exAppName: 'My App',
      endpoint: 'http://llm',
      placeholder: 'ph',
      description: 'd',
      howToUse: 'how',
      apiKey: 'sk-123',
      status: 'published',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exAppName, 'My App');
  assert.equal(body.endpoint, 'http://llm');
  assert.equal(body.status, 'published');
  assert.equal(body.apiKey, ''); // 秘匿
  assert.equal(apiKeyStore.get(`${t.id}:${body.exAppId}`), 'sk-123');
});

// ── updateExApp（#29・非対称規則） ──
test('updateExApp: name は非空時のみ・systemPrompt は無条件上書き・apiKey は指定時のみ', async () => {
  const t = await fakeTeams.create('A');
  const created = await fakeExApps.create({
    teamId: t.id,
    exAppName: 'orig',
    endpoint: 'http://llm',
    placeholder: 'ph',
    systemPrompt: 'OLD',
    description: 'd',
    howToUse: 'how',
  });
  // name 省略（既存保持）＋ systemPrompt 省略（無条件で '' へ）＋ apiKey 未指定
  const res = await api(`/teams/${t.id}/exapps/${created.exAppId}`, {
    method: 'PUT',
    body: JSON.stringify({ description: 'updated' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exAppName, 'orig'); // 非空時のみ＝保持
  assert.equal(body.description, 'updated');
  assert.equal(body.systemPrompt, ''); // 無条件上書き
  assert.equal(apiKeyStore.has(`${t.id}:${created.exAppId}`), false); // apiKey 未指定＝未更新
});

// ── getExApp（#31・メンバー可・共通チーム開放） ──
test('getExApp: 一般メンバーは取得可、共通チームは所属不問', async () => {
  const t = await fakeTeams.create('A');
  const app = await fakeExApps.create({ teamId: t.id, exAppName: 'app', endpoint: 'http://x', placeholder: '', description: '', howToUse: '' });
  members.set(`${t.id}:u9`, { teamId: t.id, userId: 'u9', username: 'u9', isAdmin: false, createdAt: now(), updatedAt: now() });
  currentAuth = { userId: 'u9', groups: [USER_GROUP], claims: {} };
  assert.equal((await api(`/teams/${t.id}/exapps/${app.exAppId}`)).status, 200);

  // 非メンバーは 403
  currentAuth = { userId: 'u-x', groups: [USER_GROUP], claims: {} };
  assert.equal((await api(`/teams/${t.id}/exapps/${app.exAppId}`)).status, 403);

  // 共通チームのアプリは所属不問
  const capp = await fakeExApps.create({ teamId: COMMON_TEAM_ID, exAppName: 'capp', endpoint: 'http://x', placeholder: '', description: '', howToUse: '' });
  teams.set(COMMON_TEAM_ID, { id: COMMON_TEAM_ID, name: '共通', createdAt: now(), updatedAt: now() });
  assert.equal((await api(`/teams/${COMMON_TEAM_ID}/exapps/${capp.exAppId}`)).status, 200);
});

// ── copyExApp（#33） ──
test('copyExApp: copyable=false は 403、正常は apiKey を複製', async () => {
  const t = await fakeTeams.create('A');
  const src = await fakeExApps.create({
    teamId: t.id,
    exAppName: 'src',
    endpoint: 'http://llm',
    placeholder: '',
    description: '',
    howToUse: '',
    copyable: false,
  });
  apiKeyStore.set(`${t.id}:${src.exAppId}`, 'sk-src');
  const reqBody = JSON.stringify({ exAppName: 'copy', placeholder: '', description: '', howToUse: '', copyable: true, status: 'draft' });
  assert.equal((await api(`/teams/${t.id}/exapps/${src.exAppId}/copy`, { method: 'POST', body: reqBody })).status, 403);

  // copyable=true に変えて複製成功
  (src.config as Record<string, unknown>).copyable = true;
  const res = await api(`/teams/${t.id}/exapps/${src.exAppId}/copy`, { method: 'POST', body: reqBody });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exAppName, 'copy');
  assert.equal(body.endpoint, 'http://llm'); // 複製元 endpoint 引き継ぎ
  assert.equal(apiKeyStore.get(`${t.id}:${body.exAppId}`), 'sk-src'); // apiKey 複製
});

// ── deleteInvokeExAppHistory（#34・本人スコープ） ──
test('deleteInvokeExAppHistory: team/exApp 実在で本人 userId の履歴を削除', async () => {
  const t = await fakeTeams.create('A');
  const app = await fakeExApps.create({ teamId: t.id, exAppName: 'app', endpoint: 'http://x', placeholder: '', description: '', howToUse: '' });
  currentAuth = { userId: 'u-me', groups: [USER_GROUP], claims: {} };
  const res = await api(`/teams/${t.id}/exapps/${app.exAppId}/history?createdDate=1700000000000`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.deepEqual(fakeHistories.deleted, [{ teamId: t.id, exAppId: app.exAppId, userId: 'u-me', createdDate: '1700000000000' }]);
});

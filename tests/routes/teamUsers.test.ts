import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { SYSTEM_ADMIN_GROUP, TEAM_ADMIN_GROUP, USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { TeamRecord, TeamUserRecord } from '../../src/lib/serialize/team.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import type { TeamUsersDeps } from '../../src/routes/teamUsers/deps.js';
import { createTeamUsersRouter } from '../../src/routes/teamUsers/index.js';

const teams = new Map<string, TeamRecord>();
const members = new Map<string, TeamUserRecord>(); // key: `${teamId}:${userId}`
let idpCalls: Array<{ op: string; userId: string; group?: string; email?: string }> = [];
let idpUsersByEmail = new Map<string, { userId: string; email: string }>();
const now = () => new Date('2026-05-26T00:00:00Z');

const fakeTeams = {
  async findById(id: string): Promise<TeamRecord | null> {
    return teams.get(id) ?? null;
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
  async listByTeam(teamId: string): Promise<{ data: TeamUserRecord[]; nextCursor?: string }> {
    return { data: [...members.values()].filter((m) => m.teamId === teamId) };
  },
  async countAdmins(teamId: string): Promise<number> {
    return [...members.values()].filter((m) => m.teamId === teamId && m.isAdmin).length;
  },
  async updateIsAdmin(teamId: string, userId: string, isAdmin: boolean): Promise<TeamUserRecord> {
    const rec = members.get(`${teamId}:${userId}`);
    if (!rec) throw new Error('P2025');
    rec.isAdmin = isAdmin;
    rec.updatedAt = now();
    return rec;
  },
  async delete(teamId: string, userId: string): Promise<void> {
    members.delete(`${teamId}:${userId}`);
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

const deps = { teams: fakeTeams, teamUsers: fakeTeamUsers, idp: fakeIdp } as unknown as TeamUsersDeps;

let currentAuth: AuthContext;
let server: Server;
let baseUrl: string;
const TEAM = 'team-1';

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use('/api', createTeamUsersRouter(deps));
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
  idpCalls = [];
  idpUsersByEmail = new Map();
  teams.set(TEAM, { id: TEAM, name: 'A', createdAt: now(), updatedAt: now() });
  currentAuth = { userId: 'u-sys', groups: [SYSTEM_ADMIN_GROUP], claims: {} };
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

// ── listTeamUsers（#35） ──
test('listTeamUsers: 0 件は空一覧（403 にしない）', async () => {
  const res = await api(`/teams/${TEAM}/users`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.teamUsers, []);
  assert.equal(body.lastEvaluatedKey, null);
});

// ── createTeamUser（#36） ──
test('createTeamUser: 未ログインメールは 404', async () => {
  const res = await api(`/teams/${TEAM}/users`, { method: 'POST', body: JSON.stringify({ email: 'x@e.jp', isAdmin: false }) });
  assert.equal(res.status, 404);
});

test('createTeamUser: isAdmin=true は TeamAdmin、false は User グループへ加入', async () => {
  idpUsersByEmail.set('admin@e.jp', { userId: 'u-a', email: 'admin@e.jp' });
  idpUsersByEmail.set('user@e.jp', { userId: 'u-b', email: 'user@e.jp' });

  const r1 = await api(`/teams/${TEAM}/users`, { method: 'POST', body: JSON.stringify({ email: 'admin@e.jp', isAdmin: true }) });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).isAdmin, true);
  assert.ok(idpCalls.some((c) => c.op === 'add' && c.userId === 'u-a' && c.group === TEAM_ADMIN_GROUP));

  const r2 = await api(`/teams/${TEAM}/users`, { method: 'POST', body: JSON.stringify({ email: 'user@e.jp', isAdmin: false }) });
  assert.equal(r2.status, 200);
  assert.ok(idpCalls.some((c) => c.op === 'add' && c.userId === 'u-b' && c.group === USER_GROUP));
});

// ── getTeamUser（#37） ──
test('getTeamUser: メンバー不在は 400', async () => {
  const res = await api(`/teams/${TEAM}/users/nope`);
  assert.equal(res.status, 400);
});

// ── updateTeamUser（#38・最後の管理者保護＝降格側） ──
test('updateTeamUser: 唯一の管理者の降格は 400', async () => {
  members.set(`${TEAM}:u1`, { teamId: TEAM, userId: 'u1', username: 'u1', isAdmin: true, createdAt: now(), updatedAt: now() });
  const res = await api(`/teams/${TEAM}/users/u1`, { method: 'PUT', body: JSON.stringify({ isAdmin: false }) });
  assert.equal(res.status, 400);
});

test('updateTeamUser: 昇格は管理者数に関係なく可・TeamAdmin 加入', async () => {
  members.set(`${TEAM}:u1`, { teamId: TEAM, userId: 'u1', username: 'u1', isAdmin: false, createdAt: now(), updatedAt: now() });
  const res = await api(`/teams/${TEAM}/users/u1`, { method: 'PUT', body: JSON.stringify({ isAdmin: true }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).isAdmin, true);
  assert.ok(idpCalls.some((c) => c.op === 'add' && c.userId === 'u1' && c.group === TEAM_ADMIN_GROUP));
});

test('updateTeamUser: 管理者 2 名なら降格可・TeamAdmin 離脱', async () => {
  members.set(`${TEAM}:u1`, { teamId: TEAM, userId: 'u1', username: 'u1', isAdmin: true, createdAt: now(), updatedAt: now() });
  members.set(`${TEAM}:u2`, { teamId: TEAM, userId: 'u2', username: 'u2', isAdmin: true, createdAt: now(), updatedAt: now() });
  const res = await api(`/teams/${TEAM}/users/u1`, { method: 'PUT', body: JSON.stringify({ isAdmin: false }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).isAdmin, false);
  assert.ok(idpCalls.some((c) => c.op === 'remove' && c.userId === 'u1' && c.group === TEAM_ADMIN_GROUP));
});

// ── deleteTeamUser（#39・最後の管理者保護＝削除側） ──
test('deleteTeamUser: 不在は 404', async () => {
  assert.equal((await api(`/teams/${TEAM}/users/nope`, { method: 'DELETE' })).status, 404);
});

test('deleteTeamUser: 唯一の管理者の削除は 400', async () => {
  members.set(`${TEAM}:u1`, { teamId: TEAM, userId: 'u1', username: 'u1', isAdmin: true, createdAt: now(), updatedAt: now() });
  assert.equal((await api(`/teams/${TEAM}/users/u1`, { method: 'DELETE' })).status, 400);
});

test('deleteTeamUser: 管理者 2 名なら管理者削除可・TeamAdmin 離脱', async () => {
  members.set(`${TEAM}:u1`, { teamId: TEAM, userId: 'u1', username: 'u1', isAdmin: true, createdAt: now(), updatedAt: now() });
  members.set(`${TEAM}:u2`, { teamId: TEAM, userId: 'u2', username: 'u2', isAdmin: true, createdAt: now(), updatedAt: now() });
  const res = await api(`/teams/${TEAM}/users/u1`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(members.has(`${TEAM}:u1`), false);
  assert.ok(idpCalls.some((c) => c.op === 'remove' && c.userId === 'u1' && c.group === TEAM_ADMIN_GROUP));
});

test('deleteTeamUser: 非管理者削除はグループ操作なしの単純削除', async () => {
  members.set(`${TEAM}:u3`, { teamId: TEAM, userId: 'u3', username: 'u3', isAdmin: false, createdAt: now(), updatedAt: now() });
  const res = await api(`/teams/${TEAM}/users/u3`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(members.has(`${TEAM}:u3`), false);
  assert.equal(idpCalls.filter((c) => c.op === 'remove').length, 0);
});

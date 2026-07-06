import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { SYSTEM_ADMIN_GROUP, TEAM_ADMIN_GROUP, USER_GROUP } from '../../src/lib/auth/groups.js';
import { ApiError } from '../../src/lib/http/errors.js';
import { assertSystemAdmin, assertTeamAdminOrSystemAdmin } from '../../src/middleware/authz.js';

function auth(groups: string[], userId = 'u-1'): AuthContext {
  return { userId, groups, claims: {} };
}

test('層1：SystemAdmin グループ保有で通過', () => {
  assert.doesNotThrow(() => assertSystemAdmin(auth([SYSTEM_ADMIN_GROUP])));
});

test('層1：SystemAdmin 非保有は 403', () => {
  assert.throws(
    () => assertSystemAdmin(auth([USER_GROUP, TEAM_ADMIN_GROUP])),
    (err: unknown) => err instanceof ApiError && err.status === 403,
  );
});

test('層2：SystemAdmin は lookup を呼ばず通過', async () => {
  let called = false;
  const lookup = async () => {
    called = true;
    return null;
  };
  await assert.doesNotReject(() => assertTeamAdminOrSystemAdmin(auth([SYSTEM_ADMIN_GROUP]), 'team-1', lookup));
  assert.equal(called, false);
});

test('層2：TeamAdmin グループ AND DB isAdmin=true で通過', async () => {
  const lookup = async (teamId: string, userId: string) => {
    assert.equal(teamId, 'team-1');
    assert.equal(userId, 'u-1');
    return { isAdmin: true };
  };
  await assert.doesNotReject(() => assertTeamAdminOrSystemAdmin(auth([TEAM_ADMIN_GROUP]), 'team-1', lookup));
});

test('層2：TeamAdmin グループでも DB isAdmin=false は 403（AND 条件）', async () => {
  const lookup = async () => ({ isAdmin: false });
  await assert.rejects(
    () => assertTeamAdminOrSystemAdmin(auth([TEAM_ADMIN_GROUP]), 'team-1', lookup),
    (err: unknown) => err instanceof ApiError && err.status === 403,
  );
});

test('層2：TeamAdmin グループでも DB に不在は 403', async () => {
  const lookup = async () => null;
  await assert.rejects(
    () => assertTeamAdminOrSystemAdmin(auth([TEAM_ADMIN_GROUP]), 'team-1', lookup),
    (err: unknown) => err instanceof ApiError && err.status === 403,
  );
});

test('層2：TeamAdmin グループ非保有は lookup を呼ばず 403', async () => {
  let called = false;
  const lookup = async () => {
    called = true;
    return { isAdmin: true };
  };
  await assert.rejects(
    () => assertTeamAdminOrSystemAdmin(auth([USER_GROUP]), 'team-1', lookup),
    (err: unknown) => err instanceof ApiError && err.status === 403,
  );
  assert.equal(called, false);
});

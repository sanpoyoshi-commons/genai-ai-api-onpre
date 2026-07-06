import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { toTeamUser } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamUsersDeps } from './deps.js';

// MIT 移植。チーム管理者 or システム管理者。チーム不在・メンバー不在はいずれも 400。
export function createGetTeamUserHandler(deps: TeamUsersDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const userId = requirePathParam(req, 'userId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const team = await deps.teams.findById(teamId);
    if (!team) {
      throw badRequest('チームが見つかりませんでした。');
    }
    const user = await deps.teamUsers.findById(teamId, userId);
    if (!user) {
      throw badRequest('ユーザーが見つかりませんでした。');
    }
    return { status: 200, body: toTeamUser(user) };
  });
}

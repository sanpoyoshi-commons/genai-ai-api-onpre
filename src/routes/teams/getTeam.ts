import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { toTeam } from '../../lib/serialize/team.js';
import { COMMON_TEAM_ID } from '../../lib/teams/constants.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';

// MIT 移植。チーム詳細。共通チームは認可ガードをスキップ。不在は 400。
export function createGetTeamHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    if (teamId !== COMMON_TEAM_ID) {
      await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));
    }

    const team = await deps.teams.findById(teamId);
    if (!team) {
      throw badRequest('チームが見つかりませんでした。');
    }
    return { status: 200, body: toTeam(team) };
  });
}

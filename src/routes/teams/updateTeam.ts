import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toTeam } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';
import { updateTeamSchema } from './schemas.js';

// チーム管理者 or システム管理者でチーム名を部分更新。
// 更新後チームを返す。不在時は repository が P2025 を投げる（更新後取得不能＝5xx）。
export function createUpdateTeamHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const { teamName } = parseBody(updateTeamSchema, req.body);
    const updated = await deps.teams.updateName(teamId, teamName);
    return { status: 200, body: toTeam(updated) };
  });
}

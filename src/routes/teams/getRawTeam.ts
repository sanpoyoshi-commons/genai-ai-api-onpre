import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { toTeam } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';

// MIT 移植。編集用のチーム取得。共通チーム特例なし＝常にチーム管理者 or システム管理者。
// 低レベル生形は PostgreSQL では消滅するため、ボディはドメイン形と同一。不在は 400。
export function createGetRawTeamHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const team = await deps.teams.findById(teamId);
    if (!team) {
      throw badRequest('チームが見つかりませんでした。');
    }
    return { status: 200, body: toTeam(team) };
  });
}

import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { decodeCursor, encodeCursor } from '../../lib/http/cursor.js';
import { getQueryParam, requirePathParam } from '../../lib/http/validation.js';
import { toTeamUser } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamUsersDeps } from './deps.js';

// チーム管理者 or システム管理者。単一認可（応答スコープ分岐なし）。
// 0 件は空一覧（listTeams と異なり 403 にしない）。名前フィルタは取らない。
export function createListTeamUsersHandler(deps: TeamUsersDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const cursor = decodeCursor(getQueryParam(req, 'exclusiveStartKey'));
    const { data, nextCursor } = await deps.teamUsers.listByTeam(teamId, cursor);

    return {
      status: 200,
      body: {
        teamUsers: data.map(toTeamUser),
        lastEvaluatedKey: nextCursor ? encodeCursor(nextCursor) : null,
      },
    };
  });
}

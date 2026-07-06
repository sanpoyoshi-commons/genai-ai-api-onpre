import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { decodeCursor, encodeCursor } from '../../lib/http/cursor.js';
import { getQueryParam, requirePathParam } from '../../lib/http/validation.js';
import { toExApp } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';

// チーム管理者 or システム管理者。単一チームの 1 ページ取得。
// 軽量射影（重い項目を空に落とす）は serialize の light で表現。0 件は空一覧（403 にしない）。
export function createListTeamExAppsHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const cursor = decodeCursor(getQueryParam(req, 'exclusiveStartKey'));
    const { data, nextCursor } = await deps.exApps.listByTeam(teamId, cursor);

    return {
      status: 200,
      body: {
        teamExApps: data.map((r) => toExApp(r, { light: true })),
        lastEvaluatedKey: nextCursor ? encodeCursor(nextCursor) : null,
      },
    };
  });
}

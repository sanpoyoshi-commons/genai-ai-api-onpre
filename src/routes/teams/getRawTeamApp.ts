import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { toExApp } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';

// MIT 移植。編集用のアプリ取得。常にチーム管理者 or システム管理者。
// 低レベル生形は PostgreSQL では消滅するため、ボディはドメイン形と同一（apiKey は空文字）。不在は 400。
export function createGetRawTeamAppHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const exAppId = requirePathParam(req, 'exAppId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const exApp = await deps.exApps.findById(teamId, exAppId);
    if (!exApp) {
      throw badRequest('AIアプリが見つかりませんでした。');
    }
    return { status: 200, body: toExApp(exApp) };
  });
}

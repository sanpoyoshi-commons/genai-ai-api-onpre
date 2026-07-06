import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { notFound } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';

// チーム管理者 or システム管理者。存在確認（不在 404）→レコード削除→
// apiKey 削除（seam）の 2 段（上流踏襲＝補償なし）。
export function createDeleteExAppHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const exAppId = requirePathParam(req, 'exAppId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const existing = await deps.exApps.findById(teamId, exAppId);
    if (!existing) {
      throw notFound('AIアプリが見つかりませんでした。');
    }
    await deps.exApps.delete(teamId, exAppId);
    await deps.apiKeys.deleteApiKey(teamId, exAppId);

    return { status: 204 };
  });
}

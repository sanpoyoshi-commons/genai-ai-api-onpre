import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toExApp } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';
import { updateExAppSchema } from './schemas.js';

// チーム管理者 or システム管理者。部分更新（非対称規則は repository）。
// apiKey は指定時のみ更新（createExApp の常時保存と非対称）。レコード更新→apiKey 更新の 2 段は補償なし。
export function createUpdateExAppHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const exAppId = requirePathParam(req, 'exAppId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const { apiKey, ...patch } = parseBody(updateExAppSchema, req.body);
    const updated = await deps.exApps.update(teamId, exAppId, patch);
    if (apiKey !== undefined) {
      await deps.apiKeys.setApiKey(teamId, exAppId, apiKey);
    }

    return { status: 200, body: toExApp(updated) };
  });
}

import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toExApp } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';
import { createExAppSchema } from './schemas.js';

// チーム管理者 or システム管理者。レコード作成→apiKey 保存（seam）の
// 別系統 2 段（上流踏襲＝補償なし）。apiKey は応答で常に空文字（秘匿）。
export function createCreateExAppHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const body = parseBody(createExAppSchema, req.body);
    const exApp = await deps.exApps.create({
      teamId,
      exAppName: body.exAppName,
      endpoint: body.endpoint,
      config: body.config,
      placeholder: body.placeholder,
      systemPrompt: body.systemPrompt,
      systemPromptKeyName: body.systemPromptKeyName,
      description: body.description,
      howToUse: body.howToUse,
      copyable: body.copyable,
      status: body.status,
    });
    await deps.apiKeys.setApiKey(teamId, exApp.exAppId, body.apiKey);

    return { status: 200, body: toExApp(exApp) };
  });
}

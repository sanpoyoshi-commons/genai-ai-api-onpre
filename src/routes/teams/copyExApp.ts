import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest, forbidden } from '../../lib/http/errors.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toExApp } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';
import { copyExAppSchema } from './schemas.js';

// MIT 移植。チーム管理者 or システム管理者。複製元の endpoint と apiKey を引き継ぎ、
// ボディの各項目で新規アプリを作成する。copyable=false は 403、複製元 apiKey 取得失敗は 400。apiKey は応答で空文字。
export function createCopyExAppHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const exAppId = requirePathParam(req, 'exAppId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const body = parseBody(copyExAppSchema, req.body);

    const team = await deps.teams.findById(teamId);
    if (!team) {
      throw badRequest('チームが見つかりませんでした。');
    }
    const source = await deps.exApps.findById(teamId, exAppId);
    if (!source) {
      throw badRequest('AIアプリが見つかりませんでした。');
    }
    const sourceApp = toExApp(source);
    if (!sourceApp.copyable) {
      throw forbidden('このAIアプリはコピーできません。');
    }

    const apiKeyValue = await deps.apiKeys.getApiKey(teamId, exAppId);
    if (!apiKeyValue) {
      throw badRequest('APIキーの取得に失敗しました。');
    }

    const copied = await deps.exApps.create({
      teamId,
      exAppName: body.exAppName,
      endpoint: sourceApp.endpoint,
      config: body.config,
      placeholder: body.placeholder,
      systemPrompt: body.systemPrompt,
      systemPromptKeyName: body.systemPromptKeyName,
      description: body.description,
      howToUse: body.howToUse,
      copyable: body.copyable,
      status: body.status,
    });
    await deps.apiKeys.setApiKey(teamId, copied.exAppId, apiKeyValue);

    return { status: 200, body: toExApp(copied) };
  });
}

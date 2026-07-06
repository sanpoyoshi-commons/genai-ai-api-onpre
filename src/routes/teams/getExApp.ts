import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { toExApp } from '../../lib/serialize/team.js';
import { COMMON_TEAM_ID } from '../../lib/teams/constants.js';
import { assertTeamMemberOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';

// MIT 移植。アプリ詳細（実行/閲覧用）。一般メンバーも可（メンバーシップ存在で通す）。
// 共通チームは認可ガードをスキップ（全認証済みユーザー可）。チーム不在・アプリ不在はいずれも 400。
export function createGetExAppHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const exAppId = requirePathParam(req, 'exAppId');

    const team = await deps.teams.findById(teamId);
    if (!team) {
      throw badRequest('チームが見つかりませんでした。');
    }
    if (teamId !== COMMON_TEAM_ID) {
      await assertTeamMemberOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));
    }

    const exApp = await deps.exApps.findById(teamId, exAppId);
    if (!exApp) {
      throw badRequest('AIアプリが見つかりませんでした。');
    }
    return { status: 200, body: toExApp(exApp) };
  });
}

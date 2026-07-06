import type { RequestHandler } from 'express';
import { TEAM_ADMIN_GROUP } from '../../lib/auth/groups.js';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { notFound } from '../../lib/http/errors.js';
import { parseBody } from '../../lib/http/validation.js';
import { toTeam, toTeamUser } from '../../lib/serialize/team.js';
import { assertSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';
import { createTeamSchema } from './schemas.js';

// MIT 移植。システム管理者がチームを作成し、指定メールのユーザーを初代チーム管理者にする。
// IdP（Keycloak）連携は seam（findUserByEmail / グループ加入）。is_admin=true の DB ＋ TeamAdminGroup の 2 系統書込。
export function createCreateTeamHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    assertSystemAdmin(auth);
    const { teamName, teamAdminEmail } = parseBody(createTeamSchema, req.body);

    const user = await deps.idp.findUserByEmail(teamAdminEmail);
    if (!user) {
      throw notFound('本環境に未ログインのユーザーです。本環境へのログインをご案内ください。');
    }
    await deps.idp.addUserToGroup(user.userId, TEAM_ADMIN_GROUP);

    const team = await deps.teams.create(teamName);
    const teamUser = await deps.teamUsers.create(team.id, user.userId, user.email, true);

    return { status: 200, body: { ...toTeam(team), teamUser: toTeamUser(teamUser) } };
  });
}

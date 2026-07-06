import type { RequestHandler } from 'express';
import { TEAM_ADMIN_GROUP, USER_GROUP } from '../../lib/auth/groups.js';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { notFound } from '../../lib/http/errors.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toTeamUser } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamUsersDeps } from './deps.js';
import { createTeamUserSchema } from './schemas.js';

// MIT 移植。チーム管理者 or システム管理者がメンバーを追加。IdP（Keycloak）で
// メール解決→isAdmin に応じたグループ（TeamAdminGroup / UserGroup）加入（seam）＋ DB メンバーシップ作成。
export function createCreateTeamUserHandler(deps: TeamUsersDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const { email, isAdmin } = parseBody(createTeamUserSchema, req.body);
    const user = await deps.idp.findUserByEmail(email);
    if (!user) {
      throw notFound('本環境に未ログインのユーザーです。本環境にログインするようご案内ください。');
    }
    await deps.idp.addUserToGroup(user.userId, isAdmin ? TEAM_ADMIN_GROUP : USER_GROUP);

    const teamUser = await deps.teamUsers.create(teamId, user.userId, user.email, isAdmin);
    return { status: 200, body: toTeamUser(teamUser) };
  });
}

import type { RequestHandler } from 'express';
import { TEAM_ADMIN_GROUP } from '../../lib/auth/groups.js';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest, notFound } from '../../lib/http/errors.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toTeamUser } from '../../lib/serialize/team.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamUsersDeps } from './deps.js';
import { updateTeamUserSchema } from './schemas.js';

// チーム管理者 or システム管理者。管理者フラグを部分更新し、
// IdP 管理者グループへ加入/離脱を同期（seam・DB is_admin と 2 系統書込）。最後の管理者保護（降格側）：管理者数 < 2 かつ
// 降格要求は 400。対象が既に非管理者でも一律 400 になりうる過剰制約は上流踏襲。
// ローカルではメンバーシップ存在（DB）を対象不在の権威とする（上流の IdP 存在解決はグループ同期 seam に内包）。
export function createUpdateTeamUserHandler(deps: TeamUsersDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const userId = requirePathParam(req, 'userId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const { isAdmin } = parseBody(updateTeamUserSchema, req.body);

    const membership = await deps.teamUsers.findById(teamId, userId);
    if (!membership) {
      throw notFound('ユーザーが見つかりませんでした。');
    }

    const adminCount = await deps.teamUsers.countAdmins(teamId);
    if (adminCount < 2 && !isAdmin) {
      throw badRequest('最後のチーム管理者を降格することはできません。');
    }

    const updated = await deps.teamUsers.updateIsAdmin(teamId, userId, isAdmin);
    if (isAdmin) {
      await deps.idp.addUserToGroup(userId, TEAM_ADMIN_GROUP);
    } else {
      await deps.idp.removeUserFromGroup(userId, TEAM_ADMIN_GROUP);
    }

    return { status: 200, body: toTeamUser(updated) };
  });
}

import type { RequestHandler } from 'express';
import { TEAM_ADMIN_GROUP } from '../../lib/auth/groups.js';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest, notFound } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { assertTeamAdminOrSystemAdmin } from '../../middleware/authz.js';
import type { TeamUsersDeps } from './deps.js';

// チーム管理者 or システム管理者。対象不在は 404。
// 管理者を削除する場合は最後の管理者保護（管理者数 < 2 で 400）＋メンバーシップ削除＋IdP 管理者グループ離脱（seam・
// 2 系統書込）。非管理者はグループ操作なしの単純削除。冪等に 204。
export function createDeleteTeamUserHandler(deps: TeamUsersDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const userId = requirePathParam(req, 'userId');
    await assertTeamAdminOrSystemAdmin(auth, teamId, (t, u) => deps.teamUsers.findMembership(t, u));

    const membership = await deps.teamUsers.findById(teamId, userId);
    if (!membership) {
      throw notFound('ユーザーが見つかりませんでした。');
    }

    if (membership.isAdmin) {
      const adminCount = await deps.teamUsers.countAdmins(teamId);
      if (adminCount < 2) {
        throw badRequest('最後のチーム管理者を削除することはできません。');
      }
      await deps.teamUsers.delete(teamId, userId);
      await deps.idp.removeUserFromGroup(userId, TEAM_ADMIN_GROUP);
    } else {
      await deps.teamUsers.delete(teamId, userId);
    }

    return { status: 204 };
  });
}

import type { RequestHandler } from 'express';
import { SYSTEM_ADMIN_GROUP } from '../../lib/auth/groups.js';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { decodeCursor, encodeCursor } from '../../lib/http/cursor.js';
import { forbidden } from '../../lib/http/errors.js';
import { getQueryParam } from '../../lib/http/validation.js';
import { toTeam } from '../../lib/serialize/team.js';
import type { TeamsDeps } from './deps.js';

// 応答スコープが認可で 2 分岐：システム管理者＝全チーム、
// それ以外＝自分が管理者のチームのみ。非システム管理者で管理対象 0 件（初回ページ）は 403（上流踏襲）。
export function createListTeamsHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const cursor = decodeCursor(getQueryParam(req, 'exclusiveStartKey'));
    const name = getQueryParam(req, 'name');
    const isSystemAdmin = auth.groups.includes(SYSTEM_ADMIN_GROUP);

    const { data, nextCursor } = isSystemAdmin
      ? await deps.teams.listAll({ cursor, name })
      : await deps.teams.listAdminScoped(auth.userId, { cursor, name });

    if (!isSystemAdmin && data.length === 0 && !cursor) {
      throw forbidden('管理対象のチームがありません。');
    }

    return {
      status: 200,
      body: {
        teams: data.map(toTeam),
        lastEvaluatedKey: nextCursor ? encodeCursor(nextCursor) : null,
      },
    };
  });
}

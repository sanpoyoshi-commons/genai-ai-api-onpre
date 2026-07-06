import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { notFound } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { assertSystemAdmin } from '../../middleware/authz.js';
import type { TeamsDeps } from './deps.js';

// システム管理者のみ。配下アプリの apiKey を後始末（seam）してから
// チームを削除（teamUsers / exApps は onDelete: Cascade で連鎖、履歴は FK 無しで残す）。冪等性のため
// 不在は 404。2 ストア横断の多段補償は上流踏襲＝なし。
export function createDeleteTeamHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    assertSystemAdmin(auth);

    const team = await deps.teams.findById(teamId);
    if (!team) {
      throw notFound('チームが見つかりません。');
    }

    const exAppIds = await deps.exApps.listAllIds(teamId);
    for (const exAppId of exAppIds) {
      await deps.apiKeys.deleteApiKey(teamId, exAppId);
    }
    await deps.teams.delete(teamId);

    return { status: 204 };
  });
}

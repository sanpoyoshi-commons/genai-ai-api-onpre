import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { requirePathParam, requireQueryParam } from '../../lib/http/validation.js';
import type { TeamsDeps } from './deps.js';

// MIT 移植。明示の管理者ガードはなく、チーム/アプリの存在確認＋本人 userId
// スコープで自分の実行履歴 1 件を削除する。team・exApp いずれか不在は 400「パラメータが不正です。」。冪等に 204。
export function createDeleteInvokeExAppHistoryHandler(deps: TeamsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requirePathParam(req, 'teamId');
    const exAppId = requirePathParam(req, 'exAppId');
    const createdDate = requireQueryParam(req, 'createdDate');

    const team = await deps.teams.findById(teamId);
    const exApp = await deps.exApps.findById(teamId, exAppId);
    if (!team || !exApp) {
      throw badRequest('パラメータが不正です。');
    }

    await deps.histories.deleteByKey(teamId, exAppId, auth.userId, createdDate);
    return { status: 204 };
  });
}

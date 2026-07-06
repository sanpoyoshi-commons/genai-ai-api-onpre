import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { requireQueryParam } from '../../lib/http/validation.js';
import { toInvokeExAppHistory } from '../../lib/serialize/invokeHistory.js';
import type { GetInvokeExAppHistoryResponse } from '../../types/genaiWeb.js';
import type { InvokeHistoriesDeps } from './deps.js';

/**
 * getInvokeExAppHistory（GET /exapps/history、MIT 移植）。teamId/exAppId/createdDate をクエリで受け、存在ガード
 * （チーム・アプリ）後、本人 userId スコープで履歴単件を取得する。不在は { history: null }。createdDate は
 * フロント契約のエポック ms 文字列。
 */
export function createGetInvokeExAppHistoryHandler(deps: InvokeHistoriesDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requireQueryParam(req, 'teamId');
    const exAppId = requireQueryParam(req, 'exAppId');
    const createdDate = requireQueryParam(req, 'createdDate');

    const [team, exApp] = await Promise.all([
      deps.teams.findById(teamId),
      deps.exApps.findById(teamId, exAppId),
    ]);
    if (!team || !exApp) {
      throw badRequest('パラメータが不正です。');
    }

    const history = await deps.histories.findByKey(teamId, exAppId, auth.userId, createdDate);
    const body: GetInvokeExAppHistoryResponse = {
      history: history ? toInvokeExAppHistory(history) : null,
    };
    return { status: 200, body };
  });
}

import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest } from '../../lib/http/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/http/cursor.js';
import { getQueryParam, requireQueryParam } from '../../lib/http/validation.js';
import { toInvokeExAppHistory } from '../../lib/serialize/invokeHistory.js';
import type { ListInvokeExAppHistoriesResponse } from '../../types/genaiWeb.js';
import type { InvokeHistoriesDeps } from './deps.js';

/**
 * listInvokeExAppHistories（GET /exapps/histories）。
 *
 * チーム/アプリ識別子はクエリパラメータ（他 ExApp 系のパスと非対称）。存在ガード（チーム・アプリ）後、
 * 認証ユーザー自身の履歴を新しい順で 1 ページ返す（明示的管理者ガードなし・本人スコープ）。履歴一覧の
 * 実体は MIT 履歴リポジトリへ委譲する。カーソルは不透明（base64）。0 件は空配列。
 */
export function createListInvokeExAppHistoriesHandler(deps: InvokeHistoriesDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const teamId = requireQueryParam(req, 'teamId');
    const exAppId = requireQueryParam(req, 'exAppId');

    const [team, exApp] = await Promise.all([
      deps.teams.findById(teamId),
      deps.exApps.findById(teamId, exAppId),
    ]);
    if (!team || !exApp) {
      throw badRequest('team or external app not found');
    }

    const cursor = decodeCursor(getQueryParam(req, 'exclusiveStartKey'));
    const { data, nextCursor } = await deps.histories.listByScope(teamId, exAppId, auth.userId, cursor);

    const body: ListInvokeExAppHistoriesResponse = {
      history: data.map(toInvokeExAppHistory),
      lastEvaluatedKey: nextCursor ? encodeCursor(nextCursor) : null,
    };
    return { status: 200, body };
  });
}

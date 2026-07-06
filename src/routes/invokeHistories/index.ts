import { Router } from 'express';
import type { InvokeHistoriesDeps } from './deps.js';
import { createGetArtifactFileHandler } from './getArtifactFile.js';
import { createGetInvokeExAppHistoryHandler } from './getInvokeExAppHistory.js';
import { createListInvokeExAppHistoriesHandler } from './listInvokeExAppHistories.js';

/**
 * invokeHistories リソース群 Router。/api 配下（requireAuth 内側）にマウント。
 * listInvokeExAppHistories／getInvokeExAppHistory／getArtifactFile。
 * いずれもクエリスコープの読取系で、本人 userId スコープ＋存在/所有権ガード。exapps Router とは別 Router だが
 * パスは /exapps/* 配下（GET histories / history / artifact-file）。
 */
export function createInvokeHistoriesRouter(deps: InvokeHistoriesDeps): Router {
  const router = Router();
  router.get('/exapps/histories', createListInvokeExAppHistoriesHandler(deps));
  router.get('/exapps/history', createGetInvokeExAppHistoryHandler(deps));
  router.get('/exapps/artifact-file', createGetArtifactFileHandler(deps));
  return router;
}

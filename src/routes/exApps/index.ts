import { Router } from 'express';
import type { ExAppQueue } from '../../lib/queue/exAppQueue.js';
import type { ExAppRepository } from '../../repositories/exAppRepository.js';
import type { InvokeHistoryRepository } from '../../repositories/invokeHistoryRepository.js';
import type { TeamRepository } from '../../repositories/teamRepository.js';
import type { TeamUserRepository } from '../../repositories/teamUserRepository.js';
import { createInvokeExAppHandler } from './invokeExApp.js';
import { createListExAppsHandler } from './listExApps.js';

/** exApps Router の依存（注入式）。listExApps と invokeExApp が共有する実依存。 */
export interface ExAppsDeps {
  queue: ExAppQueue;
  teams: TeamRepository;
  teamUsers: TeamUserRepository;
  exApps: ExAppRepository;
  histories: InvokeHistoryRepository;
}

/**
 * exApps リソース群 Router。/api 配下（requireAuth 内側）にマウント。
 * GET /exapps（横断アプリ一覧）と POST /exapps/invoke（非同期実行起票）を集約する。
 * 履歴の参照系は invokeHistories Router が担う。
 */
export function createExAppsRouter(deps: ExAppsDeps): Router {
  const router = Router();
  router.get('/exapps', createListExAppsHandler(deps));
  router.post(
    '/exapps/invoke',
    createInvokeExAppHandler({
      queue: deps.queue,
      exApps: deps.exApps,
      histories: deps.histories,
      teamUsers: deps.teamUsers,
    }),
  );
  return router;
}

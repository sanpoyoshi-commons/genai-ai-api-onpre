import { Router } from 'express';
import { createCreateSystemContextHandler } from './createSystemContext.js';
import { createDeleteSystemContextHandler } from './deleteSystemContext.js';
import type { SystemContextsDeps } from './deps.js';
import { createListSystemContextsHandler } from './listSystemContexts.js';
import { createUpdateSystemContextTitleHandler } from './updateSystemContextTitle.js';

/**
 * systemcontexts リソース群 Router（全 MIT、本人スコープ）。
 * 上流パス互換でベースパスは小文字 /systemcontexts。依存は注入式。
 */
export function createSystemContextsRouter(deps: SystemContextsDeps): Router {
  const router = Router();
  router.post('/systemcontexts', createCreateSystemContextHandler(deps));
  router.get('/systemcontexts', createListSystemContextsHandler(deps));
  router.delete('/systemcontexts/:systemContextId', createDeleteSystemContextHandler(deps));
  router.put('/systemcontexts/:systemContextId/title', createUpdateSystemContextTitleHandler(deps));
  return router;
}

import { Router } from 'express';
import type { LawRagDeps } from './deps.js';
import { createLawQueryHandler } from './query.js';

/**
 * lawRag リソース群 Router（法令名ベース忠実ポート）。/api 配下（requireAuth 内側）に
 * マウントし、apiRouter 側で requireUseCase('rag') ゲートを前置する（embedding profile 依存）。
 * POST /law-rag/query（法令名推定→法令特定→条文選別→レポート生成→出典結合）。
 */
export function createLawRagRouter(deps: LawRagDeps): Router {
  const router = Router();
  router.post('/law-rag/query', createLawQueryHandler(deps));
  return router;
}

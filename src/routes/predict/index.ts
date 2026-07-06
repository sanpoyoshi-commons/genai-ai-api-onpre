import { Router } from 'express';
import type { PredictDeps } from './deps.js';
import { createPredictHandler } from './predict.js';
import { createPredictStreamHandler } from './predictStream.js';
import { createPredictTitleHandler } from './predictTitle.js';

/**
 * predict リソース群 Router（predictStream 含む）。/api 配下（requireAuth 内側）にマウント。
 * MIT 移植。推論バックエンドは LLM seam。predictStream は上流では非ルートだったが、
 * ローカルでは POST /predict/stream として公開し JSONL（chunked）で流す。
 */
export function createPredictRouter(deps: PredictDeps): Router {
  const router = Router();
  router.post('/predict/title', createPredictTitleHandler(deps));
  router.post('/predict/stream', createPredictStreamHandler(deps));
  router.post('/predict', createPredictHandler(deps));
  return router;
}

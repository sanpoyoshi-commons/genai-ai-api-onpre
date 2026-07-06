import { Router } from 'express';
import type { CodeInterpreterDeps } from './deps.js';
import { createCodeInterpreterHandler } from './responses.js';

/**
 * codeInterpreter リソース Router。/api 配下（requireAuth 内側）にマウント。
 * 源内独自 IF の POST /code-interpreter/responses を公開する。実行は NsJail サンドボックス（profile sandbox）へ委譲。
 */
export function createCodeInterpreterRouter(deps: CodeInterpreterDeps): Router {
  const router = Router();
  router.post('/code-interpreter/responses', createCodeInterpreterHandler(deps));
  return router;
}

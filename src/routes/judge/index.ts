import { Router } from 'express';
import type { JudgeDeps } from './deps.js';
import { createJudgeHandler } from './handler.js';

/**
 * judge リソース群 Router（-onpre 新規）。/api 配下（requireAuth 内側）にマウントし、
 * apiRouter 側で requireUseCase('generate') ゲートを前置する（判定は ollama＝llm profile に依存するため、
 * 点灯条件が generate/translate/diagram と同一）。
 * POST /judge（state ＋ 問い → 1 トークン目の確率分布で答えを決める）。
 */
export function createJudgeRouter(deps: JudgeDeps): Router {
  const router = Router();
  router.post('/judge', createJudgeHandler(deps));
  return router;
}

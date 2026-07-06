import { Router, type Request, type Response } from 'express';

/**
 * GET /health — ヘルスチェック用ハンドラ。
 * docker compose up での起動確認・ヘルスチェック用。
 */
export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'genai-ai-api-onpre',
    timestamp: new Date().toISOString(),
  });
});

import express, { type Express, type RequestHandler, type Router } from 'express';
import { pinoHttp } from 'pino-http';
import { errorHandler } from './lib/http/createApiHandler.js';
import { logger } from './lib/logger.js';
import { currentRequestId, requestContext } from './middleware/requestContext.js';
import { healthRouter } from './routes/health.js';

/**
 * createApp の依存（テスト容易性のため注入式）。
 * - apiGate: /api 配下に一律適用する requireAuth。本番は requireAuthFromEnv()。
 * - apiRouter: /api 配下のリソース群 Router。
 * 省略時は /api をマウントしない（health 単体・既存テストの後方互換）。
 */
export interface AppOptions {
  apiGate?: RequestHandler;
  apiRouter?: Router;
}

/**
 * Express app 構築（上流 2 RestApi → 単一 Express 統合）。
 * 適用順序：相関コンテキスト → アクセスログ → JSON → health（認証外）
 *   → /api（requireAuth ゲート + リソース Router）→ エラー整形（最外）。
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // 相関 ID（request_id）採番と AsyncLocalStorage への保存。アクセスログより前。
  app.use(requestContext);

  // アクセスログ。req.id を request_id に揃え、HTTP 完了を
  // event=request_completed / 失敗を event=request_failed として明示出力する（pino-http
  // デフォルトの "request completed" body を昇格）。component は 'api.http' に固定。
  app.use(
    pinoHttp({
      logger,
      genReqId: () => currentRequestId() ?? '',
      customProps: () => ({ component: 'api.http' }),
      customSuccessObject: (_req, _res, val) => ({ ...(val as object), event: 'request_completed' }),
      customErrorObject: (_req, _res, _err, val) => ({ ...(val as object), event: 'request_failed' }),
    }),
  );

  // 添付ファイルは base64 で predict ボディに inline されるため、Express 既定の 100kb では
  // 数百 KB の文書でも 413(request entity too large) になる。上流互換（~4.5MB 添付）を満たす
  // 既定 10mb とし、env で可変にする（大きな inline は別途モデルの context 制約に従う）。
  app.use(express.json({ limit: process.env.API_JSON_BODY_LIMIT ?? '10mb' }));

  // health は認証外（docker compose up 起動確認・ヘルスチェック）。
  app.use(healthRouter);

  // /api：全ルート共通 requireAuth ゲート配下にリソース Router を配置（B-1）。
  if (options.apiGate) {
    const api = express.Router();
    api.use(options.apiGate);
    if (options.apiRouter) {
      api.use(options.apiRouter);
    }
    app.use('/api', api);
  }

  // エラー整形は最外層（B-3：ApiError→status+{error}／zod→400／他→500 固定）。
  app.use(errorHandler);

  return app;
}

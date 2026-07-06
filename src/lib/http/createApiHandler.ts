import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { AuthContext } from '../auth/context.js';
import { getRequestLogger } from '../../middleware/requestContext.js';
import { ApiError } from './errors.js';

/**
 * ハンドラに渡る横断コンテキスト（アダプタ方式）。上流の (event)→{statusCode,body} 形に
 * 相当する入出力を Express 上で再現する。auth は requireAuth 通過後に注入済み（/api 配下）。
 */
export interface ApiContext {
  req: Request;
  res: Response;
  auth: AuthContext;
  log: Logger;
}

export interface ApiResult {
  status: number;
  body?: unknown;
}

export type ApiHandler = (ctx: ApiContext) => Promise<ApiResult>;

/**
 * 横断ラッパ。ハンドラを実行し戻り値を JSON 整形、例外は Express エラーミドルウェアへ
 * 委譲する（整形は errorHandler に一元化）。res.headersSent 時（SSE 等）は整形をスキップ。
 */
export function createApiHandler(handler: ApiHandler): RequestHandler {
  return (req, res, next) => {
    const log = getRequestLogger();
    const auth = req.auth;
    if (!auth) {
      // 配線ミス（/api ゲートの requireAuth を経ていない）。500 として扱う。
      next(new Error('createApiHandler requires requireAuth (req.auth is missing)'));
      return;
    }
    handler({ req, res, auth, log })
      .then((result) => {
        if (res.headersSent) {
          return;
        }
        res.status(result.status).json(result.body ?? {});
      })
      .catch(next);
  };
}

/**
 * エラー整形ミドルウェア（2 分岐）。ApiError → status + {error:message}、
 * zod 検証エラー → 400、それ以外 → 500 固定文。status はハンドラ側が決め、整形はここに集約。
 * ログは request_id 付き child logger・構造化。
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const log = getRequestLogger();
  if (res.headersSent) {
    return;
  }
  if (err instanceof ApiError) {
    log.warn({ event: 'request_failed', status: err.status, error: { message: err.message } }, 'request failed');
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    const message = err.issues[0]?.message ?? 'invalid request';
    log.warn({ event: 'request_failed', status: 400, error: { message } }, 'request validation failed');
    res.status(400).json({ error: message });
    return;
  }
  log.error(
    { event: 'request_error', error: { message: err instanceof Error ? err.message : String(err) } },
    'unhandled error',
  );
  res.status(500).json({ error: 'Internal Server Error' });
};

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { logger } from '../lib/logger.js';

/**
 * リクエスト相関コンテキスト。
 * 入口で request_id を採番（X-Request-ID 尊重、無ければ UUID v4）し、AsyncLocalStorage に
 * child logger とともに保存する。以降のコードは getRequestLogger() で request_id 付きロガーを
 * call site の引き回しなしに取得できる（自動伝播）。
 */
interface RequestStore {
  requestId: string;
  log: Logger;
}

const storage = new AsyncLocalStorage<RequestStore>();
const REQUEST_ID_HEADER = 'x-request-id';

export const requestContext: RequestHandler = (req, res, next) => {
  const raw = req.headers[REQUEST_ID_HEADER];
  const incoming = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const requestId = incoming && incoming.length > 0 ? incoming : randomUUID();
  res.setHeader('X-Request-ID', requestId);
  const log = logger.child({ request_id: requestId });
  storage.run({ requestId, log }, () => {
    next();
  });
};

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function getRequestLogger(): Logger {
  return storage.getStore()?.log ?? logger;
}

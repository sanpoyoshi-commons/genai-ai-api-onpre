import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { toSystemContext } from '../../lib/serialize/systemContext.js';
import type { SystemContextsDeps } from './deps.js';

// MIT 移植。本人の一覧を配列で直返し（上流挙動）。
export function createListSystemContextsHandler(deps: SystemContextsDeps): RequestHandler {
  return createApiHandler(async ({ auth }) => {
    const items = await deps.systemContexts.listByUser(auth.userId);
    return { status: 200, body: items.map(toSystemContext) };
  });
}

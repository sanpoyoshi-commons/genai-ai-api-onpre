import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { notFound } from '../../lib/http/errors.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toSystemContext } from '../../lib/serialize/systemContext.js';
import type { SystemContextsDeps } from './deps.js';
import { updateSystemContextTitleSchema } from './schemas.js';

// MIT 移植。本人の systemContext のタイトル更新。不在は 404。
export function createUpdateSystemContextTitleHandler(deps: SystemContextsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const systemContextId = requirePathParam(req, 'systemContextId');
    const found = await deps.systemContexts.findById(auth.userId, systemContextId);
    if (!found) {
      throw notFound('システムコンテキストが見つかりません。');
    }
    const { title } = parseBody(updateSystemContextTitleSchema, req.body);
    const updated = await deps.systemContexts.setTitle(found.id, title);
    return { status: 200, body: { systemContext: toSystemContext(updated) } };
  });
}

import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { requirePathParam } from '../../lib/http/validation.js';
import type { SystemContextsDeps } from './deps.js';

// MIT 移植。本人の systemContext を削除。冪等に 204。
export function createDeleteSystemContextHandler(deps: SystemContextsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const systemContextId = requirePathParam(req, 'systemContextId');
    const found = await deps.systemContexts.findById(auth.userId, systemContextId);
    if (found) {
      await deps.systemContexts.delete(found.id);
    }
    return { status: 204 };
  });
}

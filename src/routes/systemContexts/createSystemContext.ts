import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { toSystemContext } from '../../lib/serialize/systemContext.js';
import { parseBody } from '../../lib/http/validation.js';
import type { SystemContextsDeps } from './deps.js';
import { createSystemContextSchema } from './schemas.js';

// MIT 移植。応答キーは上流挙動に合わせ { messages }。
export function createCreateSystemContextHandler(deps: SystemContextsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { systemContextTitle, systemContext } = parseBody(createSystemContextSchema, req.body);
    const created = await deps.systemContexts.create(auth.userId, systemContextTitle, systemContext);
    return { status: 200, body: { messages: toSystemContext(created) } };
  });
}

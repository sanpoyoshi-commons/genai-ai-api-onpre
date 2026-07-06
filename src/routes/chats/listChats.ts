import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { getQueryParam } from '../../lib/http/validation.js';
import { toChat } from '../../lib/serialize/chat.js';
import { type ChatsDeps, decodeCursor, encodeCursor } from './deps.js';

// MIT 移植。本人のチャット一覧（新しい順 100 件）+ 次カーソル。
export function createListChatsHandler(deps: ChatsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const cursor = decodeCursor(getQueryParam(req, 'exclusiveStartKey'));
    const { data, nextCursor } = await deps.chats.listByUser(auth.userId, cursor);
    return {
      status: 200,
      body: {
        data: data.map(toChat),
        lastEvaluatedKey: nextCursor ? encodeCursor(nextCursor) : undefined,
      },
    };
  });
}

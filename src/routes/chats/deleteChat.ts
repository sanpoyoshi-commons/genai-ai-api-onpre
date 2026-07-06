import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { requirePathParam } from '../../lib/http/validation.js';
import type { ChatsDeps } from './deps.js';

// MIT 移植。本人の chat を削除（messages は Cascade）。冪等に 204。
export function createDeleteChatHandler(deps: ChatsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const chatId = requirePathParam(req, 'chatId');
    const chat = await deps.chats.findById(auth.userId, chatId);
    if (chat) {
      await deps.chats.delete(chat.chatId);
    }
    return { status: 204 };
  });
}

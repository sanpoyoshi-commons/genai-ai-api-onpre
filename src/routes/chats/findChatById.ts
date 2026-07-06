import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { toChat } from '../../lib/serialize/chat.js';
import type { ChatsDeps } from './deps.js';

// MIT 移植。本人の chat のみ。不在は { chat: null }（上流挙動）。
export function createFindChatByIdHandler(deps: ChatsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const chatId = requirePathParam(req, 'chatId');
    const chat = await deps.chats.findById(auth.userId, chatId);
    return { status: 200, body: { chat: chat ? toChat(chat) : null } };
  });
}

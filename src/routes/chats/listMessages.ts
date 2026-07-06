import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { forbidden } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { toRecordedMessage } from '../../lib/serialize/chat.js';
import type { ChatsDeps } from './deps.js';

// MIT 移植。本人の chat のメッセージ一覧。不在は 403（上流挙動）。
export function createListMessagesHandler(deps: ChatsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const chatId = requirePathParam(req, 'chatId');
    const chat = await deps.chats.findById(auth.userId, chatId);
    if (!chat) {
      throw forbidden('Forbidden');
    }
    const messages = await deps.messages.listByChat(chat.chatId);
    return { status: 200, body: { messages: messages.map(toRecordedMessage) } };
  });
}

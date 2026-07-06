import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { notFound } from '../../lib/http/errors.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toChat } from '../../lib/serialize/chat.js';
import type { ChatsDeps } from './deps.js';
import { updateChatTitleSchema } from './schemas.js';

// MIT 移植。本人の chat のタイトル更新。不在は 404。
export function createUpdateTitleHandler(deps: ChatsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const chatId = requirePathParam(req, 'chatId');
    const chat = await deps.chats.findById(auth.userId, chatId);
    if (!chat) {
      throw notFound('チャットが見つかりません。');
    }
    const { title } = parseBody(updateChatTitleSchema, req.body);
    const updated = await deps.chats.setTitle(chat.chatId, title);
    return { status: 200, body: { chat: toChat(updated) } };
  });
}

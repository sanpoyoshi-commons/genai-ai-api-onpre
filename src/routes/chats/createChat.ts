import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { toChat } from '../../lib/serialize/chat.js';
import type { ChatsDeps } from './deps.js';

// MIT 移植。本人の空チャットを作成し Chat 型で返す。
export function createCreateChatHandler(deps: ChatsDeps): RequestHandler {
  return createApiHandler(async ({ auth }) => {
    const chat = await deps.chats.create(auth.userId);
    return { status: 200, body: { chat: toChat(chat) } };
  });
}

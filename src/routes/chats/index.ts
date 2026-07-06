import { Router } from 'express';
import { createCreateChatHandler } from './createChat.js';
import { createCreateMessagesHandler } from './createMessages.js';
import { createDeleteChatHandler } from './deleteChat.js';
import type { ChatsDeps } from './deps.js';
import { createFindChatByIdHandler } from './findChatById.js';
import { createListChatsHandler } from './listChats.js';
import { createListMessagesHandler } from './listMessages.js';
import { createUpdateTitleHandler } from './updateTitle.js';

/**
 * chats リソース群 Router（全 MIT）。/api 配下（requireAuth 内側）にマウントされる。
 * 認可は本人スコープ（repository が userId 一致を強制）。依存は注入式（ユニットテスト容易性）。
 */
export function createChatsRouter(deps: ChatsDeps): Router {
  const router = Router();
  router.post('/chats', createCreateChatHandler(deps));
  router.get('/chats', createListChatsHandler(deps));
  router.get('/chats/:chatId', createFindChatByIdHandler(deps));
  router.delete('/chats/:chatId', createDeleteChatHandler(deps));
  router.put('/chats/:chatId/title', createUpdateTitleHandler(deps));
  router.get('/chats/:chatId/messages', createListMessagesHandler(deps));
  router.post('/chats/:chatId/messages', createCreateMessagesHandler(deps));
  return router;
}

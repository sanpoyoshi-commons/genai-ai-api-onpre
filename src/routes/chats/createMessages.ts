import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { forbidden } from '../../lib/http/errors.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { toRecordedMessage } from '../../lib/serialize/chat.js';
import { assertValidExtraData } from '../../lib/storage/extraData.js';
import type { ChatsDeps } from './deps.js';
import { createMessagesSchema } from './schemas.js';

export function createCreateMessagesHandler(deps: ChatsDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const chatId = requirePathParam(req, 'chatId');
    const chat = await deps.chats.findById(auth.userId, chatId);
    if (!chat) {
      throw forbidden('You do not have permission to post messages in the chat.');
    }
    const { messages } = parseBody(createMessagesSchema, req.body);
    assertValidExtraData(messages);
    const created = await deps.messages.batchCreate(messages, auth.userId, chat.chatId);
    return { status: 200, body: { messages: created.map(toRecordedMessage) } };
  });
}

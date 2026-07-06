import type { ChatRepository } from '../../repositories/chatRepository.js';
import type { MessageRepository } from '../../repositories/messageRepository.js';

/** chats Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface ChatsDeps {
  chats: ChatRepository;
  messages: MessageRepository;
}

/** 上流の不透明 lastEvaluatedKey に対応するページネーショントークン（chatId を base64）。 */
export function encodeCursor(chatId: string): string {
  return Buffer.from(chatId, 'utf8').toString('base64');
}

export function decodeCursor(token?: string): string | undefined {
  return token ? Buffer.from(token, 'base64').toString('utf8') : undefined;
}

import { getPrisma } from '../lib/db.js';
import type { MessageRecord } from '../lib/serialize/chat.js';
import { ttlExpireAt } from '../lib/ttl.js';
import type { ToBeRecordedMessage } from '../types/genaiWeb.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

/**
 * MIT 移植（上流 `repository/messageRepository.ts`、MIT）。
 * 専用カラム（chatId/createdDate/userId/role/feedback/llmType）以外の属性
 * （messageId/usecase/trace/extraData/content 本文）は content(JSON) に内包する
 * （Message.content「マルチパート対応 JSON」を活用、schema 変更不要）。
 * createdDate は上流の "<ms>#0" 形式を維持（schema は TEXT）。
 */
const messageSelect = {
  chatId: true,
  createdDate: true,
  userId: true,
  role: true,
  content: true,
  feedback: true,
  llmType: true,
} as const;

export class MessageRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  /** SK 昇順（上流 listMessages は ScanIndexForward 既定 = 昇順）。 */
  async listByChat(chatId: string): Promise<MessageRecord[]> {
    return this.prisma.message.findMany({
      where: { chatId },
      orderBy: { createdDate: 'asc' },
      select: messageSelect,
    });
  }

  async batchCreate(
    messages: ToBeRecordedMessage[],
    userId: string,
    chatId: string,
  ): Promise<MessageRecord[]> {
    const now = Date.now();
    const expireAt = ttlExpireAt();
    const rows = messages.map((m, i) => {
      // content(JSON) に可変属性を内包（undefined キーはスプレッドで除外）。
      const content = {
        content: m.content,
        messageId: m.messageId,
        usecase: m.usecase,
        ...(m.trace !== undefined ? { trace: m.trace } : {}),
        ...(m.extraData !== undefined ? { extraData: m.extraData } : {}),
      };
      return {
        chatId,
        createdDate: m.createdDate ?? `${now + i}#0`,
        userId,
        role: m.role,
        content: content as unknown as Prisma.InputJsonObject,
        feedback: 'none',
        llmType: m.llmType ?? '',
        expireAt,
      };
    });

    await this.prisma.message.createMany({ data: rows });

    return rows.map((r) => ({
      chatId: r.chatId,
      createdDate: r.createdDate,
      userId: r.userId,
      role: r.role,
      content: r.content,
      feedback: r.feedback,
      llmType: r.llmType,
    }));
  }
}

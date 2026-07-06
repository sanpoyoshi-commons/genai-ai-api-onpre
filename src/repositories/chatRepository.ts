import { randomUUID } from 'node:crypto';
import { getPrisma } from '../lib/db.js';
import type { ChatRecord } from '../lib/serialize/chat.js';
import { ttlExpireAt } from '../lib/ttl.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * MIT 移植（上流 `repository/chatRepository.ts`、MIT は直接移植可）。
 * DynamoDB（PK=user#<uid>, SK=createdDate, 属性 chatId）→ Prisma 正規化（chatId が PK）へ翻訳。
 * 本人スコープ：参照系は userId 一致を WHERE で強制し他人の chat を返さない。PK は生 uuid 保存。
 */
const PAGE_SIZE = 100; // 上流 listChats は 1 度に 100 件返す。

const chatSelect = {
  chatId: true,
  userId: true,
  title: true,
  createdDate: true,
  updatedDate: true,
} as const;

export class ChatRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async create(userId: string): Promise<ChatRecord> {
    return this.prisma.chat.create({
      data: { chatId: randomUUID(), userId, expireAt: ttlExpireAt() },
      select: chatSelect,
    });
  }

  /** 本人の chat のみ（userId 不一致は null）。 */
  async findById(userId: string, chatId: string): Promise<ChatRecord | null> {
    return this.prisma.chat.findFirst({ where: { chatId, userId }, select: chatSelect });
  }

  /** 新しい順 100 件 + 次カーソル（chatId）。上流の不透明 lastEvaluatedKey に対応。 */
  async listByUser(userId: string, cursor?: string): Promise<{ data: ChatRecord[]; nextCursor?: string }> {
    const rows = await this.prisma.chat.findMany({
      where: { userId },
      orderBy: { createdDate: 'desc' },
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { chatId: cursor }, skip: 1 } : {}),
      select: chatSelect,
    });
    const hasMore = rows.length > PAGE_SIZE;
    const data = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.chatId : undefined;
    return { data, nextCursor };
  }

  async setTitle(chatId: string, title: string): Promise<ChatRecord> {
    return this.prisma.chat.update({ where: { chatId }, data: { title }, select: chatSelect });
  }

  /** messages は schema の onDelete: Cascade で連鎖削除される（上流は手動 batch 削除）。 */
  async delete(chatId: string): Promise<void> {
    await this.prisma.chat.delete({ where: { chatId } });
  }
}

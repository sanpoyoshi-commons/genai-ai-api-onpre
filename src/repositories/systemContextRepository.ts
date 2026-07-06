import { randomUUID } from 'node:crypto';
import { getPrisma } from '../lib/db.js';
import type { SystemContextRecord } from '../lib/serialize/systemContext.js';
import { ttlExpireAt } from '../lib/ttl.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * MIT 移植（上流 `repository/systemContextRepository.ts`）。
 * DynamoDB（PK=systemContext#<uid>）→ Prisma 正規化（id が PK・userId 別）へ翻訳。
 * 本人スコープ：参照系は userId 一致を WHERE で強制。PK は生 uuid 保存。
 */
const systemContextSelect = {
  id: true,
  userId: true,
  title: true,
  systemContext: true,
  createdDate: true,
} as const;

export class SystemContextRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async create(userId: string, title: string, systemContext: string): Promise<SystemContextRecord> {
    return this.prisma.systemContext.create({
      data: { id: randomUUID(), userId, title, systemContext, expireAt: ttlExpireAt() },
      select: systemContextSelect,
    });
  }

  /** 本人の systemContext のみ（userId 不一致は null）。 */
  async findById(userId: string, id: string): Promise<SystemContextRecord | null> {
    return this.prisma.systemContext.findFirst({ where: { id, userId }, select: systemContextSelect });
  }

  /** 新しい順（上流は ScanIndexForward false）。 */
  async listByUser(userId: string): Promise<SystemContextRecord[]> {
    return this.prisma.systemContext.findMany({
      where: { userId },
      orderBy: { createdDate: 'desc' },
      select: systemContextSelect,
    });
  }

  async setTitle(id: string, title: string): Promise<SystemContextRecord> {
    return this.prisma.systemContext.update({ where: { id }, data: { title }, select: systemContextSelect });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.systemContext.delete({ where: { id } });
  }
}

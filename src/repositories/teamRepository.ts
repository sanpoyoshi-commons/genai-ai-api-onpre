import { randomUUID } from 'node:crypto';
import { getPrisma } from '../lib/db.js';
import type { TeamRecord } from '../lib/serialize/team.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * チーム本体エンティティ（teams）への Prisma アクセス層。PostgreSQL 正規化で実装する。
 *
 * 提供操作は生成・単件解決・全チーム列挙・管理者スコープ列挙・チーム名部分更新・削除。
 * 低レベル生形解決はローカルでは消滅（findById へ委譲）。複数一括解決・ユーザー所属列挙の消費側は
 * 未到達のため実装しない（増えたら追加）。時刻型の生成/更新非対称は TIMESTAMPTZ に統一して吸収する。
 * 並行更新は last-write-wins 踏襲。
 */
const PAGE_SIZE = 100;

const teamSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class TeamRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  /** チーム生成。識別子はサーバ側採番（生 uuid）、作成/更新時刻は @default(now())/@updatedAt で同値初期化。 */
  async create(name: string): Promise<TeamRecord> {
    return this.prisma.team.create({ data: { id: randomUUID(), name }, select: teamSelect });
  }

  /** チーム単件解決（ドメイン形）。不在は null。低レベル生形（findRawById）も同一実体へ委譲。 */
  async findById(id: string): Promise<TeamRecord | null> {
    return this.prisma.team.findUnique({ where: { id }, select: teamSelect });
  }

  /**
   * 全チーム列挙（システム管理者経路）。名前部分一致フィルタ（大小無視）任意・新しい順・カーソル付き。
   * 上流の GSI-1 走査は PostgreSQL の index + WHERE + keyset ページングで表現する。
   */
  async listAll(options: { cursor?: string; name?: string }): Promise<{ data: TeamRecord[]; nextCursor?: string }> {
    return this.listWhere(options.name ? { name: { contains: options.name, mode: 'insensitive' as const } } : {}, options.cursor);
  }

  /**
   * 管理者スコープ列挙（非システム管理者経路）。呼び出しユーザーが管理者であるチームのみ。
   * 上流の「管理者メンバーシップ → チームID → 各 ID をチーム本体へ解決」2 段は、リレーション WHERE で 1 段に
   * 集約する（DynamoDB GSI 由来の 2 段は store 固有・結果は同値）。0 件は呼び出し側ハンドラが 403 判定する。
   */
  async listAdminScoped(
    userId: string,
    options: { cursor?: string; name?: string },
  ): Promise<{ data: TeamRecord[]; nextCursor?: string }> {
    const where = {
      teamUsers: { some: { userId, isAdmin: true } },
      ...(options.name ? { name: { contains: options.name, mode: 'insensitive' as const } } : {}),
    };
    return this.listWhere(where, options.cursor);
  }

  /** チーム名部分更新。更新時刻は @updatedAt でサーバ側採番。不在時は Prisma が P2025 を投げる。 */
  async updateName(id: string, name: string): Promise<TeamRecord> {
    return this.prisma.team.update({ where: { id }, data: { name }, select: teamSelect });
  }

  /** チーム削除。teamUsers / exApps は schema の onDelete: Cascade で連鎖削除される（履歴は FK 無しで残る）。 */
  async delete(id: string): Promise<void> {
    await this.prisma.team.delete({ where: { id } });
  }

  private async listWhere(
    where: Record<string, unknown>,
    cursor?: string,
  ): Promise<{ data: TeamRecord[]; nextCursor?: string }> {
    const rows = await this.prisma.team.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: teamSelect,
    });
    const hasMore = rows.length > PAGE_SIZE;
    const data = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id : undefined;
    return { data, nextCursor };
  }
}

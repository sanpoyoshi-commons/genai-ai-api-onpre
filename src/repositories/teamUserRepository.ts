import { getPrisma } from '../lib/db.js';
import type { TeamUserRecord } from '../lib/serialize/team.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * team_users（チームメンバーシップ＋管理者フラグ）への Prisma アクセス層。PostgreSQL 正規化で実装する。
 *
 * 提供操作は生成・単件解決・チーム単位列挙・部分更新・削除（不在 graceful）。
 * 認可層が使う findMembership は既存。最後の管理者保護の管理者数は、上流のページング全走査を count に
 * 簡素化する（DynamoDB 走査は store 固有・結果は同値）。時刻は TIMESTAMPTZ 統一。並行更新は last-write-wins 踏襲。
 */
const PAGE_SIZE = 100;

const teamUserSelect = {
  teamId: true,
  userId: true,
  username: true,
  isAdmin: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class TeamUserRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  /** チーム内メンバーシップ（admin 判定に必要な最小フィールド）。不在は null。認可層が使う。 */
  async findMembership(teamId: string, userId: string): Promise<{ isAdmin: boolean } | null> {
    const row = await this.prisma.teamUser.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { isAdmin: true },
    });
    return row ? { isAdmin: row.isAdmin } : null;
  }

  /** メンバーシップ生成。作成/更新時刻は @default(now())/@updatedAt で同値初期化。 */
  async create(teamId: string, userId: string, username: string, isAdmin: boolean): Promise<TeamUserRecord> {
    return this.prisma.teamUser.create({
      data: { teamId, userId, username, isAdmin },
      select: teamUserSelect,
    });
  }

  /** メンバーシップ単件解決。不在は null。 */
  async findById(teamId: string, userId: string): Promise<TeamUserRecord | null> {
    return this.prisma.teamUser.findUnique({ where: { teamId_userId: { teamId, userId } }, select: teamUserSelect });
  }

  /** チーム単位メンバーシップ列挙（カーソル付き）。0 件は空配列（ハンドラは 403 にしない）。 */
  async listByTeam(teamId: string, cursor?: string): Promise<{ data: TeamUserRecord[]; nextCursor?: string }> {
    const rows = await this.prisma.teamUser.findMany({
      where: { teamId },
      orderBy: { userId: 'asc' },
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { teamId_userId: { teamId, userId: cursor } }, skip: 1 } : {}),
      select: teamUserSelect,
    });
    const hasMore = rows.length > PAGE_SIZE;
    const data = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.userId : undefined;
    return { data, nextCursor };
  }

  /** チームの管理者数（最後の管理者保護の不変条件判定に使う）。上流の全走査を count へ簡素化。 */
  async countAdmins(teamId: string): Promise<number> {
    return this.prisma.teamUser.count({ where: { teamId, isAdmin: true } });
  }

  /** メンバーシップ部分更新（管理者フラグ＋更新時刻）。不在時は Prisma が P2025 を投げる。 */
  async updateIsAdmin(teamId: string, userId: string, isAdmin: boolean): Promise<TeamUserRecord> {
    return this.prisma.teamUser.update({
      where: { teamId_userId: { teamId, userId } },
      data: { isAdmin },
      select: teamUserSelect,
    });
  }

  /** メンバーシップ削除（不在は無操作＝graceful not-found／冪等）。 */
  async delete(teamId: string, userId: string): Promise<void> {
    await this.prisma.teamUser.deleteMany({ where: { teamId, userId } });
  }

  /**
   * ユーザーの所属チーム ID を全件列挙する（listExApps の横断スコープ）。上流はカーソルが尽きるまで反復して
   * 全収集する。本リポは正規化 WHERE で一括取得し、store 固有の走査を畳む（結果は同値）。
   */
  async listTeamIdsByUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.teamUser.findMany({
      where: { userId },
      orderBy: { teamId: 'asc' },
      select: { teamId: true },
    });
    return rows.map((r) => r.teamId);
  }
}

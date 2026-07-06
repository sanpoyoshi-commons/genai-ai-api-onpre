import { randomUUID } from 'node:crypto';
import { getPrisma } from '../lib/db.js';
import type { ExAppConfigPayload, ExAppRecord } from '../lib/serialize/team.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { ExAppStatus } from '../types/genaiWeb.js';

/**
 * アプリ登録（ex_apps）への Prisma アクセス層。PostgreSQL 正規化で実装する。呼び出し用シークレットは保持しない
 * （別経路＝ApiKeyStore seam。応答では常に空文字）。
 *
 * フロント契約 ExApp の endpoint/placeholder/systemPrompt/systemPromptKeyName/howToUse/copyable/status は専用カラムが
 * 無いため config(Json) ペイロードへ封入する（展開は serialize/team.ts）。部分更新の項目別非対称規則：
 * 多くは非空時のみ更新（既存保持）、systemPrompt 系 2 項目は条件なし常時上書き（空でも上書き）、copyable は真偽値時のみ、
 * status は 2 値ホワイトリスト一致時のみ。上流踏襲で忠実移植する。
 */

/** invoke 履歴のスナップショットに用いるアプリ登録の最小射影（存在確認兼用）。 */
export interface ExAppSnapshot {
  exAppName: string;
  teamName: string;
}

/** アプリ登録の作成入力（apiKey は含めない＝ApiKeyStore seam が別途保存）。 */
export interface CreateExAppInput {
  teamId: string;
  exAppName: string;
  endpoint: string;
  config?: string;
  placeholder: string;
  systemPrompt?: string;
  systemPromptKeyName?: string;
  description: string;
  howToUse: string;
  copyable?: boolean;
  status?: ExAppStatus;
}

/** アプリ登録の部分更新パッチ（全項目任意。非対称規則は update 参照）。 */
export interface UpdateExAppPatch {
  exAppName?: string;
  endpoint?: string;
  config?: string;
  placeholder?: string;
  systemPrompt?: string;
  systemPromptKeyName?: string;
  description?: string;
  howToUse?: string;
  copyable?: boolean;
  status?: ExAppStatus;
}

const PAGE_SIZE = 100;

const exAppSelect = {
  teamId: true,
  exAppId: true,
  name: true,
  description: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

const isStatus = (v: unknown): v is ExAppStatus => v === 'draft' || v === 'published';
const nonEmpty = (v: string | undefined): v is string => typeof v === 'string' && v.length > 0;
const asJson = (p: ExAppConfigPayload): Prisma.InputJsonValue => p as unknown as Prisma.InputJsonValue;

function buildPayload(input: CreateExAppInput): ExAppConfigPayload {
  return {
    endpoint: input.endpoint,
    config: input.config ?? '',
    placeholder: input.placeholder,
    systemPrompt: input.systemPrompt ?? '',
    systemPromptKeyName: input.systemPromptKeyName ?? '',
    howToUse: input.howToUse,
    copyable: input.copyable ?? false,
    status: input.status ?? 'draft',
  };
}

export class ExAppRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  /**
   * チーム識別子＋アプリ識別子で 1 件取得し、スナップショット用の名称を返す。不在は null。
   * チーム名は team リレーションを 1 クエリで同時取得する（teamRepository を増やさない）。
   */
  async findSnapshotById(teamId: string, exAppId: string): Promise<ExAppSnapshot | null> {
    const row = await this.prisma.exApp.findUnique({
      where: { teamId_exAppId: { teamId, exAppId } },
      select: { name: true, team: { select: { name: true } } },
    });
    return row ? { exAppName: row.name, teamName: row.team.name } : null;
  }

  /** アプリ登録の作成。識別子はサーバ側採番（生 uuid）。作成/更新時刻は同値初期化。 */
  async create(input: CreateExAppInput): Promise<ExAppRecord> {
    return this.prisma.exApp.create({
      data: {
        teamId: input.teamId,
        exAppId: randomUUID(),
        name: input.exAppName,
        description: input.description,
        config: asJson(buildPayload(input)),
      },
      select: exAppSelect,
    });
  }

  /** 単件取得（ドメイン形）。不在は null。低レベル生形（findRawById）も同一実体へ委譲。 */
  async findById(teamId: string, exAppId: string): Promise<ExAppRecord | null> {
    return this.prisma.exApp.findUnique({ where: { teamId_exAppId: { teamId, exAppId } }, select: exAppSelect });
  }

  /**
   * worker が外部呼び出し先を引く＝config(Json) ペイロードから endpoint を取り出す。不在/未設定は null。
   * endpoint は専用カラム無しのため config ペイロードへ封入されている（buildPayload／unpackConfig 参照）。
   */
  async findEndpoint(teamId: string, exAppId: string): Promise<string | null> {
    const row = await this.prisma.exApp.findUnique({
      where: { teamId_exAppId: { teamId, exAppId } },
      select: { config: true },
    });
    if (!row) {
      return null;
    }
    const endpoint = (row.config as { endpoint?: unknown } | null)?.endpoint;
    return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : null;
  }

  /** チーム配下のアプリ登録一覧（カーソル付き）。軽量射影は serialize 層（toExApp light）で落とす。 */
  async listByTeam(teamId: string, cursor?: string): Promise<{ data: ExAppRecord[]; nextCursor?: string }> {
    const rows = await this.prisma.exApp.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { teamId_exAppId: { teamId, exAppId: cursor } }, skip: 1 } : {}),
      select: exAppSelect,
    });
    const hasMore = rows.length > PAGE_SIZE;
    const data = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.exAppId : undefined;
    return { data, nextCursor };
  }

  /** チーム配下の全アプリ識別子（deleteTeam の apiKey 後始末・カスケード前の収集用）。 */
  async listAllIds(teamId: string): Promise<string[]> {
    const rows = await this.prisma.exApp.findMany({ where: { teamId }, select: { exAppId: true } });
    return rows.map((r) => r.exAppId);
  }

  /**
   * アプリ登録の部分更新（非対称規則）。対象不在時は汎用エラーを送出（リポジトリ更新失敗＝5xx）。
   * name/endpoint/config/placeholder/description/howToUse は非空時のみ更新、copyable は真偽値時のみ、status は
   * 2 値一致時のみ、systemPrompt/systemPromptKeyName は条件なし常時上書き（空でも上書き＝上流踏襲）。
   */
  async update(teamId: string, exAppId: string, patch: UpdateExAppPatch): Promise<ExAppRecord> {
    const existing = await this.prisma.exApp.findUnique({
      where: { teamId_exAppId: { teamId, exAppId } },
      select: exAppSelect,
    });
    if (!existing) {
      throw new Error('ex_app update target not found');
    }
    const cur = (existing.config ?? {}) as Partial<ExAppConfigPayload>;
    const merged: ExAppConfigPayload = {
      endpoint: nonEmpty(patch.endpoint) ? patch.endpoint : (cur.endpoint ?? ''),
      config: nonEmpty(patch.config) ? patch.config : (cur.config ?? ''),
      placeholder: nonEmpty(patch.placeholder) ? patch.placeholder : (cur.placeholder ?? ''),
      howToUse: nonEmpty(patch.howToUse) ? patch.howToUse : (cur.howToUse ?? ''),
      copyable: typeof patch.copyable === 'boolean' ? patch.copyable : (cur.copyable ?? false),
      status: isStatus(patch.status) ? patch.status : (isStatus(cur.status) ? cur.status : 'draft'),
      // systemPrompt 系 2 項目は条件なし常時上書き（空でも上書き＝上流踏襲）。
      systemPrompt: patch.systemPrompt ?? '',
      systemPromptKeyName: patch.systemPromptKeyName ?? '',
    };
    return this.prisma.exApp.update({
      where: { teamId_exAppId: { teamId, exAppId } },
      data: {
        ...(nonEmpty(patch.exAppName) ? { name: patch.exAppName } : {}),
        ...(nonEmpty(patch.description) ? { description: patch.description } : {}),
        config: asJson(merged),
      },
      select: exAppSelect,
    });
  }

  /** アプリ登録の削除。 */
  async delete(teamId: string, exAppId: string): Promise<void> {
    await this.prisma.exApp.delete({ where: { teamId_exAppId: { teamId, exAppId } } });
  }
}

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../lib/db.js';
import type { FileStorage } from '../lib/storage/fileStorage.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/**
 * ExApp 呼び出し履歴（invoke_ex_app_histories）への DB アクセス層。
 *
 * 本リポジトリは MIT のため本リポで新規実装する。送信側 invokeExApp が status=running で 1 件作成し、worker が
 * 状態確認の結果で status / outputs を書き戻す（DB 設計の status 遷移・非正規化スナップショット）。
 *
 * 入力（inputs）退避：base64 ファイル等で巨大化しうる inputs は、閾値超で SeaweedFS へ退避し DB 行には
 * マーカ参照（{ __inputsRef: "s3://..." }）のみ残す（行肥大の抑止。出力 artifacts 退避と対称）。読取系
 * （findExecution / findByKey / listByScope）で透過的に復元する。storage 未注入時は退避せず素通し（後方互換）。
 */

/** inputs を退避する閾値（バイト）。これを超える inputs はストレージへ退避する。 */
const INPUTS_OFFLOAD_THRESHOLD_BYTES = 10_240;

/** DB の inputs 列に格納する退避マーカ。 */
interface OffloadedInputsRef {
  __inputsRef: string;
}

function isOffloadedInputsRef(v: unknown): v is OffloadedInputsRef {
  return typeof v === 'object' && v !== null && typeof (v as OffloadedInputsRef).__inputsRef === 'string';
}

/** s3://bucket/key を bucket / key に分解する。不正は null。 */
function parseStorageUrl(url: string): { bucket: string; key: string } | null {
  const m = /^s3:\/\/(?<bucket>[^/]+)\/(?<key>.+)$/.exec(url);
  return m?.groups?.bucket && m.groups.key ? { bucket: m.groups.bucket, key: m.groups.key } : null;
}

/** 履歴行の複合キー（team_id / ex_app_id / user_id / created_date）。 */
export interface HistoryKey {
  teamId: string;
  exAppId: string;
  userId: string;
  createdDate: Date;
}

export interface CreateHistoryInput {
  teamId: string;
  exAppId: string;
  userId: string;
  /** 実行時点のチーム名（非正規化スナップショット、履歴の永続性）。 */
  teamNameSnapshot: string;
  /** 実行時点のアプリ表示名（非正規化スナップショット）。 */
  exAppNameSnapshot: string;
  /** 呼び出し入力（JSON 値）。Prisma 入力型へのキャストは repository 内部に閉じる。 */
  inputs: unknown;
}

export type HistoryStatus = 'running' | 'success' | 'error';

/** worker が外部呼び出しに用いる実行コンテキスト（起票時 inputs ＋ 非同期 polling 状態）。 */
export interface ExecutionContext {
  inputs: unknown;
  /** 非同期 ExApp の status_url。null＝未 POST（初回）。非 null＝以後 polling。 */
  statusUrl: string | null;
  externalRequestId: string | null;
  status: string;
}

/** 取得系（listInvokeExAppHistories #42 / getInvokeExAppHistory #43）が返す履歴行。serialize 層が応答へ写像する。 */
export interface HistoryRecord {
  teamId: string;
  exAppId: string;
  userId: string;
  createdDate: Date;
  teamNameSnapshot: string;
  exAppNameSnapshot: string;
  inputs: unknown;
  outputs: unknown;
  status: string;
}

const historySelect = {
  teamId: true,
  exAppId: true,
  userId: true,
  createdDate: true,
  teamNameSnapshot: true,
  exAppNameSnapshot: true,
  inputs: true,
  outputs: true,
  status: true,
} as const;

const HISTORY_PAGE_SIZE = 100;

export class InvokeHistoryRepository {
  constructor(
    private readonly prisma: PrismaClient = getPrisma(),
    /** inputs 退避用ストレージ。未注入なら退避しない（後方互換）。 */
    private readonly storage?: Pick<FileStorage, 'getObject' | 'putObject'>,
    /** inputs 退避先バケット。未設定なら退避しない。 */
    private readonly inputsBucket?: string,
  ) {}

  /** 履歴を status=running で作成し、採番された複合キーを返す。 */
  async create(input: CreateHistoryInput): Promise<HistoryKey> {
    const storedInputs = await this.maybeOffloadInputs(input);
    return this.prisma.invokeExAppHistory.create({
      data: {
        teamId: input.teamId,
        exAppId: input.exAppId,
        userId: input.userId,
        teamNameSnapshot: input.teamNameSnapshot,
        exAppNameSnapshot: input.exAppNameSnapshot,
        inputs: storedInputs as Prisma.InputJsonValue,
        status: 'running',
      },
      select: { teamId: true, exAppId: true, userId: true, createdDate: true },
    });
  }

  /** inputs が閾値超ならストレージへ退避し、DB にはマーカ参照のみ残す。storage 未注入/閾値以下は素通し。 */
  private async maybeOffloadInputs(input: CreateHistoryInput): Promise<unknown> {
    if (!this.storage || !this.inputsBucket) {
      return input.inputs;
    }
    const serialized = JSON.stringify(input.inputs ?? {});
    if (Buffer.byteLength(serialized, 'utf8') <= INPUTS_OFFLOAD_THRESHOLD_BYTES) {
      return input.inputs;
    }
    const key = `inputs/${input.teamId}/${input.exAppId}/${input.userId}/${randomUUID()}.json`;
    await this.storage.putObject(this.inputsBucket, key, new Uint8Array(Buffer.from(serialized, 'utf8')), 'application/json');
    return { __inputsRef: `s3://${this.inputsBucket}/${key}` } satisfies OffloadedInputsRef;
  }

  /** 退避マーカなら復元、そうでなければ素通し。storage 未注入で復元不能なら（防御的に）マーカのまま返す。 */
  private async rehydrateInputs(inputs: unknown): Promise<unknown> {
    if (!isOffloadedInputsRef(inputs) || !this.storage) {
      return inputs;
    }
    const parsed = parseStorageUrl(inputs.__inputsRef);
    if (!parsed) {
      return inputs;
    }
    const bytes = await this.storage.getObject(parsed.bucket, parsed.key);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  }

  /**
   * worker が外部呼び出しに必要な実行コンテキストを引く（起票時 inputs ＋ 非同期 polling 用 statusUrl）。不在は null。
   * statusUrl 非 null＝既に初回 POST 済みで status_url を受領済み（以後の受信は polling へ分岐）。
   */
  async findExecution(key: HistoryKey): Promise<ExecutionContext | null> {
    const row = await this.prisma.invokeExAppHistory.findUnique({
      where: { teamId_exAppId_userId_createdDate: key },
      select: { inputs: true, statusUrl: true, externalRequestId: true, status: true },
    });
    if (!row) {
      return null;
    }
    return { ...row, inputs: await this.rehydrateInputs(row.inputs) };
  }

  /** 非同期 ExApp の外部状態（status_url／request_id）を永続化する（初回 POST で 202 受領時）。 */
  async saveExternalState(key: HistoryKey, statusUrl: string, externalRequestId: string | null): Promise<void> {
    await this.prisma.invokeExAppHistory.update({
      where: { teamId_exAppId_userId_createdDate: key },
      data: { statusUrl, externalRequestId },
    });
  }

  /** 状態確認の結果で status / outputs を更新する（worker から呼ばれる）。outputs 不在は JSON null。 */
  async updateResult(key: HistoryKey, status: HistoryStatus, outputs: unknown): Promise<void> {
    await this.prisma.invokeExAppHistory.update({
      where: { teamId_exAppId_userId_createdDate: key },
      data: {
        status,
        outputs: outputs === null || outputs === undefined ? Prisma.JsonNull : (outputs as Prisma.InputJsonValue),
      },
    });
  }

  /**
   * 履歴 1 件削除（deleteInvokeExAppHistory #34）。createdDate は API 互換のため文字列（エポックms）で受け、
   * 複合キーへ復元する。不在は無操作（deleteMany で graceful・冪等）。本人 userId スコープはハンドラが渡す。
   */
  async deleteByKey(teamId: string, exAppId: string, userId: string, createdDate: string): Promise<void> {
    const at = new Date(Number(createdDate));
    await this.prisma.invokeExAppHistory.deleteMany({ where: { teamId, exAppId, userId, createdDate: at } });
  }

  /**
   * 履歴単件取得（getInvokeExAppHistory #43）。本人 userId スコープ。createdDate は API 互換のためエポック ms 文字列で
   * 受け、複合キーへ復元する。不在は null。
   */
  async findByKey(
    teamId: string,
    exAppId: string,
    userId: string,
    createdDate: string,
  ): Promise<HistoryRecord | null> {
    const at = new Date(Number(createdDate));
    const row = await this.prisma.invokeExAppHistory.findUnique({
      where: { teamId_exAppId_userId_createdDate: { teamId, exAppId, userId, createdDate: at } },
      select: historySelect,
    });
    if (!row) {
      return null;
    }
    return { ...row, inputs: await this.rehydrateInputs(row.inputs) };
  }

  /**
   * 履歴一覧（listInvokeExAppHistories #42）。本人 userId スコープ・新しい順。カーソルは前ページ末尾の createdDate
   * （ms 文字列）。ハンドラが base64 で不透明化する。0 件は空配列。
   */
  async listByScope(
    teamId: string,
    exAppId: string,
    userId: string,
    cursor?: string,
  ): Promise<{ data: HistoryRecord[]; nextCursor?: string }> {
    const rows = await this.prisma.invokeExAppHistory.findMany({
      where: { teamId, exAppId, userId },
      orderBy: { createdDate: 'desc' },
      take: HISTORY_PAGE_SIZE + 1,
      ...(cursor
        ? {
            cursor: {
              teamId_exAppId_userId_createdDate: {
                teamId,
                exAppId,
                userId,
                createdDate: new Date(Number(cursor)),
              },
            },
            skip: 1,
          }
        : {}),
      select: historySelect,
    });
    const hasMore = rows.length > HISTORY_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, HISTORY_PAGE_SIZE) : rows;
    const data = await Promise.all(page.map(async (r) => ({ ...r, inputs: await this.rehydrateInputs(r.inputs) })));
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? String(last.createdDate.getTime()) : undefined;
    return { data, nextCursor };
  }
}

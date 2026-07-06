import type { ExApp, ExAppStatus, Team, TeamUser } from '../../types/genaiWeb.js';

/**
 * チーム管理ドメインの API 応答境界 整形層（内部正規化・境界で上流型へ整形）。
 *
 * repository は正規化形（生 uuid・Date）を返し、ここで上流 web 互換型へ写像する。Team/TeamUser/ExApp は
 * フロント契約に pk/sk プレフィックスを持たない（genaiWeb.ts 参照）ため単純写像。createdDate/updatedDate は
 * 上流同様エポックミリ秒文字列に統一する（内部 TIMESTAMPTZ の型非対称を本層で吸収）。
 *
 * ExApp はフロント契約が endpoint/placeholder/systemPrompt/systemPromptKeyName/howToUse/copyable/status を
 * 持つが、Prisma ExApp は name/description/config(Json) のみ。これらの追加項目は config(Json) ペイロードへ
 * 封入し（Message.content と同パターン）、本層で展開する。apiKey は仕様に従い常に空文字で返す。
 */

const ms = (d: Date): string => String(d.getTime());

/** repository が返す正規化済み Team 行（schema.prisma の select に一致）。 */
export interface TeamRecord {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/** repository が返す正規化済み TeamUser 行。 */
export interface TeamUserRecord {
  teamId: string;
  userId: string;
  username: string;
  isAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** repository が返す正規化済み ExApp 行（config は封入ペイロード）。 */
export interface ExAppRecord {
  teamId: string;
  exAppId: string;
  name: string;
  description: string | null;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * ExApp.config(Json) に封入する追加項目（専用カラム外の上流 ExApp 属性）。
 * createExApp/copyExApp 作成時・updateExApp 更新時に組み立て、serialize で展開する。
 */
export interface ExAppConfigPayload {
  endpoint: string;
  /** 任意設定文字列（上流 ExApp.config、既定 ''）。 */
  config: string;
  placeholder: string;
  systemPrompt: string;
  systemPromptKeyName: string;
  howToUse: string;
  copyable: boolean;
  status: ExAppStatus;
}

export function toTeam(row: TeamRecord): Team {
  return {
    teamId: row.id,
    teamName: row.name,
    createdDate: ms(row.createdAt),
    updatedDate: ms(row.updatedAt),
  };
}

export function toTeamUser(row: TeamUserRecord): TeamUser {
  return {
    teamId: row.teamId,
    userId: row.userId,
    username: row.username,
    isAdmin: row.isAdmin,
    createdDate: ms(row.createdAt),
    updatedDate: ms(row.updatedAt),
  };
}

const isStatus = (v: unknown): v is ExAppStatus => v === 'draft' || v === 'published';

/** config(Json) を防御的既定で展開する（欠損時の既定＝防御的補完に対応）。 */
function unpackConfig(raw: unknown): ExAppConfigPayload {
  const p = (raw ?? {}) as Partial<ExAppConfigPayload>;
  return {
    endpoint: p.endpoint ?? '',
    config: p.config ?? '',
    placeholder: p.placeholder ?? '',
    systemPrompt: p.systemPrompt ?? '',
    systemPromptKeyName: p.systemPromptKeyName ?? '',
    howToUse: p.howToUse ?? '',
    copyable: p.copyable ?? false,
    status: isStatus(p.status) ? p.status : 'draft',
  };
}

/**
 * ExApp を上流型へ写像。apiKey は常に空文字（秘匿）。
 * light=true（一覧・listTeamExApps）は重い項目（endpoint/config/systemPrompt/systemPromptKeyName）を
 * 空に落とした軽量射影で返す（DynamoDB ProjectionExpression 相当の上流挙動踏襲）。
 */
export function toExApp(row: ExAppRecord, options?: { light?: boolean }): ExApp {
  const c = unpackConfig(row.config);
  const light = options?.light === true;
  return {
    teamId: row.teamId,
    exAppId: row.exAppId,
    exAppName: row.name,
    endpoint: light ? '' : c.endpoint,
    config: light ? '' : c.config,
    placeholder: c.placeholder,
    systemPrompt: light ? '' : c.systemPrompt,
    systemPromptKeyName: light ? '' : c.systemPromptKeyName,
    description: row.description ?? '',
    howToUse: c.howToUse,
    apiKey: '',
    copyable: c.copyable,
    status: c.status,
    createdDate: ms(row.createdAt),
    updatedDate: ms(row.updatedAt),
  };
}

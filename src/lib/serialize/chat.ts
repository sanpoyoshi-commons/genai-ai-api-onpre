import type { Chat, ExtraData, RecordedMessage, Role } from '../../types/genaiWeb.js';

/**
 * API 応答境界の整形層（内部正規化・境界で上流型へ整形）。
 *
 * repository は正規化形（生 uuid・Date）を返し、ここで上流 web 互換型へ写像する。
 * これによりフロント無改修と内部クリーンさを両立する。`id`/`chatId` の
 * プレフィックス（user#／chat#）と createdDate の ms 文字列化は本層に閉じる。
 */

/** repository が返す正規化済み Chat 行（schema.prisma の select に一致）。 */
export interface ChatRecord {
  chatId: string;
  userId: string;
  title: string | null;
  createdDate: Date;
  updatedDate: Date;
}

/** repository が返す正規化済み Message 行（createdDate は "<ms>#0" 形式の TEXT）。 */
export interface MessageRecord {
  chatId: string;
  createdDate: string;
  userId: string;
  role: string;
  content: unknown;
  feedback: string | null;
  llmType: string | null;
}

/** Message.content(JSON) に内包する可変ペイロード（専用カラム外の上流属性）。 */
interface MessageContentPayload {
  content?: string;
  trace?: string;
  extraData?: ExtraData[];
  messageId?: string;
  usecase?: string;
}

export function toChat(row: ChatRecord): Chat {
  return {
    id: `user#${row.userId}`,
    createdDate: String(row.createdDate.getTime()),
    chatId: `chat#${row.chatId}`,
    usecase: '',
    title: row.title ?? '',
    updatedDate: String(row.updatedDate.getTime()),
  };
}

export function toRecordedMessage(row: MessageRecord): RecordedMessage {
  const payload = (row.content ?? {}) as MessageContentPayload;
  return {
    id: `chat#${row.chatId}`,
    createdDate: row.createdDate,
    messageId: payload.messageId ?? '',
    usecase: payload.usecase ?? '',
    userId: row.userId,
    feedback: row.feedback ?? 'none',
    role: row.role as Role,
    content: payload.content ?? '',
    trace: payload.trace,
    extraData: payload.extraData,
    llmType: row.llmType ?? '',
  };
}

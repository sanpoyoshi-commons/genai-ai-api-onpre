import type { SystemContext } from '../../types/genaiWeb.js';

/**
 * SystemContext の応答境界整形（response shape policy）。
 * 上流は id・systemContextId とも "systemContext#" プレフィックス（chats の user#/chat# とは別）。
 * フロントは systemContextId を decomposeId で剥がすため、プレフィックスを境界で付与する。
 */

/** repository が返す正規化済み SystemContext 行（schema.prisma の select に一致）。 */
export interface SystemContextRecord {
  id: string; // 生 uuid（PK）
  userId: string;
  title: string;
  systemContext: string;
  createdDate: Date;
}

export function toSystemContext(row: SystemContextRecord): SystemContext {
  return {
    id: `systemContext#${row.userId}`,
    createdDate: String(row.createdDate.getTime()),
    systemContextId: `systemContext#${row.id}`,
    systemContext: row.systemContext,
    systemContextTitle: row.title,
  };
}

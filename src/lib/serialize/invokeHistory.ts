import type { HistoryRecord } from '../../repositories/invokeHistoryRepository.js';
import type { ExAppArtifactRef, ExAppInvokeStatus, InvokeExAppHistory } from '../../types/genaiWeb.js';

/**
 * 呼び出し履歴の応答整形（境界で上流型へ整形、response shape policy）。
 *
 * 内部 DB の status（running/success/error）を、フロント契約の ExAppInvokeStatus（大文字）へ写像する。
 * created_date は ms 文字列、teamName/exAppName は履歴の非正規化スナップショットを用いる（実行時点の永続値）。
 * outputs は DB の Json をフロント契約の string へ整形（object は JSON 文字列化、null は空文字）。progress は
 * 本リポでは未追跡のため空文字（フロント契約のフィールドは保つ）。
 */
const STATUS_MAP: Record<string, ExAppInvokeStatus> = {
  running: 'IN_PROGRESS',
  success: 'COMPLETED',
  error: 'ERROR',
};

/** worker が artifacts 退避時に書き込む構造化 outputs（{ outputs: string, artifacts: [...] }）。 */
function isStructuredOutputs(v: unknown): v is { outputs: unknown; artifacts: unknown } {
  return typeof v === 'object' && v !== null && 'outputs' in v && 'artifacts' in v;
}

function isArtifactRef(v: unknown): v is ExAppArtifactRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ExAppArtifactRef).displayName === 'string' &&
    typeof (v as ExAppArtifactRef).s3Url === 'string'
  );
}

function toOutputsString(outputs: unknown): string {
  if (outputs === null || outputs === undefined) {
    return '';
  }
  return typeof outputs === 'string' ? outputs : JSON.stringify(outputs);
}

export function toInvokeExAppHistory(row: HistoryRecord): InvokeExAppHistory {
  // worker が artifacts を退避した場合、DB outputs は { outputs, artifacts } の構造化形。テキストのみは string。
  const raw = row.outputs;
  const outputsText = isStructuredOutputs(raw) ? toOutputsString(raw.outputs) : toOutputsString(raw);
  const artifacts =
    isStructuredOutputs(raw) && Array.isArray(raw.artifacts)
      ? raw.artifacts.filter(isArtifactRef)
      : undefined;

  return {
    teamId: row.teamId,
    teamName: row.teamNameSnapshot,
    exAppId: row.exAppId,
    exAppName: row.exAppNameSnapshot,
    userId: row.userId,
    inputs: (row.inputs ?? {}) as Record<string, unknown>,
    outputs: outputsText,
    createdDate: String(row.createdDate.getTime()),
    status: STATUS_MAP[row.status] ?? 'ACCEPTED',
    progress: '',
    ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
  };
}

import { decodeJobMessage, type ExAppJobMessage } from '../lib/exapp/jobMessage.js';
import type { HistoryStatus, InvokeHistoryRepository } from '../repositories/invokeHistoryRepository.js';
import type { ReceivedJob } from '../lib/queue/exAppQueue.js';
import type { JobProcessor, JobResult } from './pollExAppStatus.js';

/**
 * ExApp 実行状態確認の結果（worker の seam 出力）。
 * done=false なら未完了（可視性延長で再配信）、true なら完了として履歴へ書き戻す。
 */
export interface ExAppStatusResult {
  done: boolean;
  status?: Extract<HistoryStatus, 'success' | 'error'>;
  outputs?: unknown;
}

/**
 * 外部 ExApp の実行状態を確認する seam。
 *
 * 実装本体（ExApp config のエンドポイント呼び出し・LLM 抽象化層経由の結果取得・10KB 超 /
 * base64 の SeaweedFS 退避）は外部 ExApp サービス／LLM 抽象化層 導入後に差し込む。
 * この境界を seam として切り、履歴更新メカニクス（Prisma）までを縦スライスする。
 */
export type ExAppStatusChecker = (message: ExAppJobMessage, job: ReceivedJob) => Promise<ExAppStatusResult>;

export interface ProcessExAppJobDeps {
  histories: Pick<InvokeHistoryRepository, 'updateResult'>;
  checkStatus: ExAppStatusChecker;
}

/**
 * ジョブ処理本体（d）。受信ジョブの履歴キーを復号 → 状態確認（seam）→ 完了なら
 * invoke_ex_app_histories を success/error と outputs で更新し completed=true を返す。
 * 未完了は completed=false（runPollExAppStatus が受信回数に応じてバックオフ・再配信）。
 */
export function createExAppJobProcessor(deps: ProcessExAppJobDeps): JobProcessor {
  return async (job: ReceivedJob): Promise<JobResult> => {
    const message = decodeJobMessage(job.body);
    const result = await deps.checkStatus(message, job);
    if (!result.done) {
      return { completed: false };
    }
    await deps.histories.updateResult(
      {
        teamId: message.teamId,
        exAppId: message.exAppId,
        userId: message.userId,
        createdDate: new Date(message.createdDate),
      },
      result.status ?? 'success',
      result.outputs ?? null,
    );
    return { completed: true };
  };
}

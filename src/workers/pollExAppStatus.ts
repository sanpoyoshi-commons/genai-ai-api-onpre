import { logger } from '../lib/logger.js';
import { backoffVisibilitySeconds } from '../lib/queue/backoff.js';
import type { ExAppQueue, ReceivedJob } from '../lib/queue/exAppQueue.js';

/**
 * ジョブ処理結果。completed=true で削除（完了）、false で可視性延長（未完了→再配信）。
 * 処理本体（ExApp 実行状態確認 + Prisma invoke history 更新）は requireAuth / Prisma
 * 導入後に差し込むため、ここでは seam（注入される関数）として切る。
 */
export type JobResult = { completed: boolean };
export type JobProcessor = (job: ReceivedJob) => Promise<JobResult>;

export interface WorkerOptions {
  /** ロングポーリングの待機秒（SQS 上限 20）。 */
  waitTimeSeconds?: number;
  /** 停止判定。true を返すとループを抜ける（graceful shutdown）。 */
  shouldStop?: () => boolean;
  /** ログの component 名（exApp／文字起こしで複数ループを並走させるため分離可能に）。 */
  component?: string;
}

const SQS_MAX_WAIT_SECONDS = 20;
const DEFAULT_WORKER_COMPONENT = 'api.worker.exapp';

/**
 * ExApp 非同期実行ポーリングワーカー（疑似ロングポーリング）。
 *
 * 受信 → ジョブ処理 → 完了なら削除、未完了なら受信回数に応じたバックオフで可視性を延長
 * （非削除＝再配信）。例外時も削除せず可視性経過後に再配信させる（リトライ駆動）。
 *
 * 可視性の変更は「受信したメッセージ」に対して行う（受信後）。ロングポーリングの待機中に
 * 可視性を変更する経路ではないため、ElasticMQ Issue #81（待機中 long-poll での
 * ChangeMessageVisibility タイミング差）の影響を受けない（W-07-1 実機確認対象）。
 */
export async function runPollExAppStatus(
  queue: ExAppQueue,
  processJob: JobProcessor,
  options: WorkerOptions = {},
): Promise<void> {
  const waitTimeSeconds = Math.min(options.waitTimeSeconds ?? SQS_MAX_WAIT_SECONDS, SQS_MAX_WAIT_SECONDS);
  const shouldStop = options.shouldStop ?? (() => false);
  const component = options.component ?? DEFAULT_WORKER_COMPONENT;

  logger.info({ component, event: 'worker_started' }, 'queue worker started');

  while (!shouldStop()) {
    const job = await queue.receiveJob(waitTimeSeconds);
    if (!job) {
      continue;
    }

    const log = logger.child({
      component,
      message_id: job.messageId,
      receive_count: job.receiveCount,
    });

    try {
      const result = await processJob(job);
      if (result.completed) {
        await queue.completeJob(job.receiptHandle);
        log.info({ event: 'job_completed' }, 'exapp job completed');
      } else {
        const visibilitySeconds = backoffVisibilitySeconds(job.receiveCount);
        await queue.deferJob(job.receiptHandle, visibilitySeconds);
        log.debug({ event: 'job_deferred', visibility_seconds: visibilitySeconds }, 'exapp job deferred (backoff)');
      }
    } catch (err) {
      // 削除せず可視性経過後に再配信させる（リトライ駆動）。
      const visibilitySeconds = backoffVisibilitySeconds(job.receiveCount);
      try {
        await queue.deferJob(job.receiptHandle, visibilitySeconds);
      } catch (deferErr) {
        log.error(
          { event: 'job_defer_failed', error: { message: deferErr instanceof Error ? deferErr.message : String(deferErr) } },
          'failed to defer job after processing error',
        );
      }
      log.error(
        {
          event: 'job_failed',
          visibility_seconds: visibilitySeconds,
          error: { message: err instanceof Error ? err.message : String(err) },
        },
        'exapp job processing failed',
      );
    }
  }

  logger.info({ component, event: 'worker_stopped' }, 'queue worker stopped');
}

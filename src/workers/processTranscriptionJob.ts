import { basename } from 'node:path';
import { logger } from '../lib/logger.js';
import type { ReceivedJob } from '../lib/queue/exAppQueue.js';
import type { FileStorage } from '../lib/storage/fileStorage.js';
import { decodeTranscriptionJobMessage } from '../lib/transcription/jobMessage.js';
import type { TranscriptionJobRepository } from '../repositories/transcriptionJobRepository.js';
import type { TranscriptionAdapter } from '../transcription/adapters/base.js';
import { isTranscriptionError } from '../transcription/errors.js';
import { normalizeTranscription } from '../transcription/normalize.js';
import type { JobProcessor, JobResult } from './pollExAppStatus.js';

const WORKER_COMPONENT = 'api.worker.transcription';

/**
 * 文字起こしジョブ処理本体（worker・DB ジョブ＋専用ワーカー）。
 *
 * 受信した jobName で行を引き、音声を storage から取得 → Whisper（faster-whisper）→ 正規化 → COMPLETED 書き戻し。
 * 冪等：行不在 or 既 COMPLETED/FAILED は再処理せず completed=true（可視性超過の二重配信対策）。エラー分岐は
 * TranscriptionError.retryable で決める：一過性（接続・タイムアウト・5xx・レート）は throw して再配信（runPoll が
 * バックオフ・DLQ で頭打ち）、恒久（不正音声・モデル不在）は FAILED 確定して completed=true（無限リトライ回避）。
 * 話者分離は非対応＝speakerLabel/maxSpeakers は受領のみで、normalize が単一話者にまとめる。
 */
export interface ProcessTranscriptionJobDeps {
  repo: Pick<
    TranscriptionJobRepository,
    'findByJobName' | 'markInProgress' | 'markCompleted' | 'markFailed'
  >;
  storage: Pick<FileStorage, 'getObject'>;
  adapter: TranscriptionAdapter;
  /** 音声バケット名（config が解決して渡す）。 */
  audioBucket: string;
}

export function createTranscriptionJobProcessor(deps: ProcessTranscriptionJobDeps): JobProcessor {
  return async (job: ReceivedJob): Promise<JobResult> => {
    const { jobName } = decodeTranscriptionJobMessage(job.body);
    const log = logger.child({ component: WORKER_COMPONENT, job_name: jobName });

    const record = await deps.repo.findByJobName(jobName);
    if (!record || record.status === 'COMPLETED' || record.status === 'FAILED') {
      // 行が消えた／既に終端＝冪等にスキップ（削除して再配信を止める）。
      log.debug({ event: 'job_skipped', status: record?.status ?? 'missing' }, 'transcription job skipped');
      return { completed: true };
    }

    await deps.repo.markInProgress(jobName);
    try {
      const audio = await deps.storage.getObject(deps.audioBucket, record.audioKey);
      const result = await deps.adapter.transcribe({
        audio,
        filename: basename(record.audioKey) || 'audio',
      });
      const { languageCode, transcripts } = normalizeTranscription(result);
      await deps.repo.markCompleted(jobName, languageCode, transcripts);
      log.info({ event: 'job_completed', language_code: languageCode }, 'transcription job completed');
      return { completed: true };
    } catch (err) {
      if (isTranscriptionError(err) && err.retryable) {
        // 一過性。throw して runPollExAppStatus に再配信（バックオフ）させる。行は IN_PROGRESS のまま。
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      await deps.repo.markFailed(jobName, message);
      log.warn({ event: 'job_failed_terminal', error: { message } }, 'transcription job failed (terminal)');
      return { completed: true };
    }
  };
}

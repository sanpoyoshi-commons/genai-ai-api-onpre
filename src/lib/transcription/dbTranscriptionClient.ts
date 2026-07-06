import { randomUUID } from 'node:crypto';
import type { ExAppQueue } from '../queue/exAppQueue.js';
import { TranscriptionJobRepository } from '../../repositories/transcriptionJobRepository.js';
import { encodeTranscriptionJobMessage } from './jobMessage.js';
import type {
  StartTranscriptionInput,
  TranscriptionClient,
  TranscriptionJob,
} from './transcriptionClient.js';

/**
 * 文字起こし seam の実装（DB ジョブ＋専用ワーカー）。
 *
 * 上流 AWS Transcribe のマネージド非同期を、DB（状態の真実）＋ElasticMQ（トリガ）＋worker（本体）で再現する。
 * api 側の本クライアントは状態ストアの起票（startJob）と読み出し（getJob）だけを担い、Whisper 呼び出し・
 * 音声 DL・正規化は worker（pollTranscriptionStatus）に閉じる。所有権突合（owner_user_id 一致）は handler が
 * getJob 結果で行う。queue は SQS 互換ラッパ（ExAppQueue）を transcribe キュー URL でインスタンス化して注入する。
 */
export class DbTranscriptionClient implements TranscriptionClient {
  private readonly queue: Pick<ExAppQueue, 'enqueueJob'>;
  private readonly repo: TranscriptionJobRepository;

  constructor(deps: { queue: Pick<ExAppQueue, 'enqueueJob'>; repo?: TranscriptionJobRepository }) {
    this.queue = deps.queue;
    this.repo = deps.repo ?? new TranscriptionJobRepository();
  }

  /**
   * ジョブを採番・QUEUED で起票し、jobName をトリガとしてキューへ投入する。
   *
   * create→enqueue の順で、enqueue が失敗すると worker が決して処理しない QUEUED 孤児行が残り、
   * フロントが COMPLETED にならず無限ポーリングする（C-TRS 項④）。enqueue 失敗時は起票を補償削除して
   * から元例外を再送出し、孤児行を残さない（DB＋別プロセス queue を跨ぐため分散トランザクションは張れず、
   * create を真実源とした補償で整合を保つ）。
   */
  async startJob(input: StartTranscriptionInput): Promise<{ jobName: string }> {
    const jobName = randomUUID();
    await this.repo.create({
      jobName,
      ownerUserId: input.userId,
      audioKey: input.audioKey,
      speakerLabel: input.speakerLabel,
      maxSpeakers: input.maxSpeakers,
    });
    try {
      await this.queue.enqueueJob(encodeTranscriptionJobMessage({ jobName }));
    } catch (err) {
      await this.repo.deleteByJobName(jobName); // 孤児行を残さない（補償は best-effort）
      throw err;
    }
    return { jobName };
  }

  /** ジョブ状態を取得する。COMPLETED は languageCode＋正規化済み transcripts を同梱。不在は null。 */
  async getJob(jobName: string): Promise<TranscriptionJob | null> {
    const record = await this.repo.findByJobName(jobName);
    if (!record) {
      return null;
    }
    return {
      jobName: record.jobName,
      ownerUserId: record.ownerUserId,
      status: record.status,
      ...(record.languageCode !== null ? { languageCode: record.languageCode } : {}),
      ...(record.transcripts !== null ? { transcripts: record.transcripts } : {}),
    };
  }
}

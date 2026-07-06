import { getPrisma } from '../lib/db.js';
import type { Transcript } from '../types/genaiWeb.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/**
 * 文字起こしジョブ（transcription_jobs）への DB アクセス層（MIT）。
 *
 * 上流は AWS Transcribe のマネージド非同期に状態を委ねるが、ローカル（Whisper 系＝同期 API）は
 * 状態の真実を本テーブルに持つ。api（startTranscription）が status=QUEUED で起票し、worker
 * （pollTranscriptionStatus）が音声 DL→Whisper→正規化を経て COMPLETED / FAILED へ書き戻す。
 * 所有権突合（owner_user_id 一致）は handler が getJob 結果で行う（本層は素直な CRUD）。
 */

/** ジョブ状態（AWS Transcribe 語彙に揃える。フロント契約 GetTranscriptionResponse.status へそのまま載る）。 */
export type TranscriptionStatus = 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

/** ジョブ起票入力（jobName は採番済みを渡す）。 */
export interface CreateTranscriptionJobInput {
  jobName: string;
  ownerUserId: string;
  audioKey: string;
  speakerLabel: boolean;
  maxSpeakers: number;
}

/** ジョブ行（取得系が返す。DbTranscriptionClient が seam の TranscriptionJob へ写像する）。 */
export interface TranscriptionJobRecord {
  jobName: string;
  ownerUserId: string;
  audioKey: string;
  status: string;
  speakerLabel: boolean;
  maxSpeakers: number;
  languageCode: string | null;
  transcripts: Transcript[] | null;
}

const jobSelect = {
  jobName: true,
  ownerUserId: true,
  audioKey: true,
  status: true,
  speakerLabel: true,
  maxSpeakers: true,
  languageCode: true,
  transcripts: true,
} as const;

export class TranscriptionJobRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  /** ジョブを status=QUEUED で作成する（api startTranscription）。 */
  async create(input: CreateTranscriptionJobInput): Promise<void> {
    await this.prisma.transcriptionJob.create({
      data: {
        jobName: input.jobName,
        ownerUserId: input.ownerUserId,
        audioKey: input.audioKey,
        status: 'QUEUED',
        speakerLabel: input.speakerLabel,
        maxSpeakers: input.maxSpeakers,
      },
    });
  }

  /** ジョブ 1 件取得（api getTranscription / worker 冪等チェック）。不在は null。transcripts は JSON から復元。 */
  async findByJobName(jobName: string): Promise<TranscriptionJobRecord | null> {
    const row = await this.prisma.transcriptionJob.findUnique({
      where: { jobName },
      select: jobSelect,
    });
    if (!row) {
      return null;
    }
    return {
      jobName: row.jobName,
      ownerUserId: row.ownerUserId,
      audioKey: row.audioKey,
      status: row.status,
      speakerLabel: row.speakerLabel,
      maxSpeakers: row.maxSpeakers,
      languageCode: row.languageCode,
      transcripts: (row.transcripts as Transcript[] | null) ?? null,
    };
  }

  /**
   * ジョブ行を削除する。enqueue 失敗時に QUEUED 起票を取り消す補償用（C-TRS 項④）。
   * 既に不在でもエラーにしない（補償は best-effort＝二重削除や競合で落とさない）。
   */
  async deleteByJobName(jobName: string): Promise<void> {
    await this.prisma.transcriptionJob.deleteMany({ where: { jobName } });
  }

  /** worker が処理開始時に IN_PROGRESS へ遷移させる。 */
  async markInProgress(jobName: string): Promise<void> {
    await this.prisma.transcriptionJob.update({
      where: { jobName },
      data: { status: 'IN_PROGRESS', error: null },
    });
  }

  /** worker が完了時に COMPLETED ＋ 正規化済み transcripts ＋ 検出言語を書き戻す。 */
  async markCompleted(jobName: string, languageCode: string, transcripts: Transcript[]): Promise<void> {
    await this.prisma.transcriptionJob.update({
      where: { jobName },
      data: {
        status: 'COMPLETED',
        languageCode,
        transcripts: transcripts as unknown as Prisma.InputJsonValue,
        error: null,
      },
    });
  }

  /** worker が恒久エラー時に FAILED ＋ 理由を記録する（応答には載せず運用観測用）。 */
  async markFailed(jobName: string, error: string): Promise<void> {
    await this.prisma.transcriptionJob.update({
      where: { jobName },
      data: { status: 'FAILED', error },
    });
  }
}

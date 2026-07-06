import type { Transcript } from '../../types/genaiWeb.js';

/**
 * 文字起こしの seam（seam 注入＋実バックエンド配線は後続）。
 *
 * 上流は AWS Transcribe（StartTranscriptionJob→jobName、GetTranscriptionJob でポーリング、完了で S3 の
 * transcript JSON を取得・話者マージ・日本語スペース除去）。ローカル代替は Whisper 系（faster-whisper-server 等）
 * で、非同期ジョブの状態管理方式も未確定。よってここではインターフェースのみ
 * 定義して deps 注入し、ジョブ起票・状態取得・transcript 正規化は実装側に閉じる（idp/apiKey と同方式）。
 * 所有権は起票時の userId をジョブに紐付け、取得時に owner を返して handler が突合する。unit は fake 注入。
 */

export interface StartTranscriptionInput {
  /** 音声ストレージキー（所有権プレフィックス付き）。実装側が s3/SeaweedFS 参照へ変換する。 */
  audioKey: string;
  /** 話者分離の有無。 */
  speakerLabel: boolean;
  /** 話者分離時の最大話者数。 */
  maxSpeakers: number;
  /** 起票ユーザー（所有権タグ）。 */
  userId: string;
}

export interface TranscriptionJob {
  jobName: string;
  /** 起票ユーザー（所有権突合に使う）。 */
  ownerUserId: string;
  /** ジョブ状態（COMPLETED で transcripts/languageCode が埋まる）。 */
  status: string;
  languageCode?: string;
  transcripts?: Transcript[];
}

export interface TranscriptionClient {
  /** ジョブ起票。採番された jobName を返す（上流 startTranscription 相当）。 */
  startJob(input: StartTranscriptionInput): Promise<{ jobName: string }>;
  /** ジョブ取得（状態＋完了時は正規化済み transcripts）。不在は null。所有権突合は handler。 */
  getJob(jobName: string): Promise<TranscriptionJob | null>;
}

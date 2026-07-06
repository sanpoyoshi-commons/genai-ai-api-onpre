import { z } from 'zod';

/**
 * 文字起こし非同期ジョブのメッセージ本体（送信側 startTranscription ⇔ 受信側 worker の契約）。
 *
 * 状態の真実は transcription_jobs テーブルが持つため、キューには起票済み jobName のみを載せる
 * （ExApp の複合キー方式と異なり単一キー）。worker はこの jobName で行を引き、音声 DL→Whisper→
 * 正規化の結果を書き戻す。SQS body は文字列のため JSON 文字列で運ぶ。
 */
export const transcriptionJobMessageSchema = z.object({
  jobName: z.string().min(1),
});

export type TranscriptionJobMessage = z.infer<typeof transcriptionJobMessageSchema>;

/** メッセージをキュー送信用の文字列へ符号化する。 */
export function encodeTranscriptionJobMessage(message: TranscriptionJobMessage): string {
  return JSON.stringify(message);
}

/** 受信した body を検証して復号する（不正形は ZodError を送出）。 */
export function decodeTranscriptionJobMessage(body: string): TranscriptionJobMessage {
  return transcriptionJobMessageSchema.parse(JSON.parse(body));
}

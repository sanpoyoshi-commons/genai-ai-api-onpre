import { z } from 'zod';

/**
 * ExApp 非同期実行ジョブのメッセージ本体（送信側 invokeExApp ⇔ 受信側 worker の契約）。
 *
 * 送信側は invoke_ex_app_histories を作成し、その複合キー（teamId / exAppId / userId /
 * createdDate）を本メッセージへ載せてキューへ投入する。worker はこのキーで履歴行を引き、
 * 状態確認の結果を書き戻す。createdDate は ISO 8601 文字列で運ぶ（SQS body は文字列のため）。
 */
export const exAppJobMessageSchema = z.object({
  teamId: z.string().min(1),
  exAppId: z.string().min(1),
  userId: z.string().min(1),
  createdDate: z.string().min(1),
});

export type ExAppJobMessage = z.infer<typeof exAppJobMessageSchema>;

/** メッセージをキュー送信用の文字列へ符号化する。 */
export function encodeJobMessage(message: ExAppJobMessage): string {
  return JSON.stringify(message);
}

/** 受信した body を検証して復号する（不正形は ZodError を送出）。 */
export function decodeJobMessage(body: string): ExAppJobMessage {
  return exAppJobMessageSchema.parse(JSON.parse(body));
}

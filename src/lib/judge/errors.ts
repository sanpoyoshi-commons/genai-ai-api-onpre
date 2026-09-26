/**
 * 判定ルート（POST /api/judge）の失敗種別（-onpre 新規）。
 *
 * lib 層は HTTP を知らず（SandboxError / LLMError と同流儀）、route ハンドラが
 * ApiError へ写像する（judge/handler.ts の toApiError）。
 *
 * 値フリー方針：message に state 本文・確率値・モデル出力を載せない。上流の応答ボディも
 * 載せない（プロンプトを反射して返す実装があり得るため、status だけを載せる）。
 */
export type JudgeErrorCode =
  /** 判定対象 state が JUDGE_MAX_STATE_BYTES 超（→400）。 */
  | 'state_too_large'
  /**
   * state を JSON 文字列にできなかった（`JSON.stringify` が `RangeError`＝入れ子が深すぎて再帰が
   * 溢れる／結果が文字列長の上限を超える・→400）。**深さの上限は掛けない**（文字列化できる入力は
   * すべて通す）ため、実際に溢れたときだけ入力側の問題として 400 にする。
   */
  | 'state_not_serializable'
  /** コンテキスト長を超える恐れ（送信前のバイト上界／送信後の prompt_eval_count・→422）。 */
  | 'context_overflow'
  /** 上流 Ollama が非 2xx／応答が不正（→502）。 */
  | 'upstream'
  /** 候補（選択肢）が top_logprobs に 1 つも現れなかった（→502）。一様分布では埋めない。 */
  | 'no_candidate'
  /** 上流が時間内に応答しなかった（リトライ予算・全体予算を使い切った・→504）。 */
  | 'timeout'
  /**
   * 呼び出し側が接続を切った（→ステータスを設定せず終了）。**タイムアウトとは別物**で、
   * 再試行しない（応答を受け取る相手が既にいない）。
   */
  | 'client_abort'
  /** 既定モデルが未設定（JUDGE_DEFAULT_MODEL も OLLAMA_DEFAULT_CHAT_MODEL も無い・→503）。 */
  | 'model_unavailable'
  /** 許可リスト（JUDGE_ALLOWED_MODELS）外のモデル指定（→400）。 */
  | 'model_not_allowed';

export class JudgeError extends Error {
  readonly code: JudgeErrorCode;

  constructor(code: JudgeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'JudgeError';
    this.code = code;
  }
}

export function isJudgeError(error: unknown): error is JudgeError {
  return error instanceof JudgeError;
}

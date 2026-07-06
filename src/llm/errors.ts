/**
 * 統一エラー型。各経路アダプタが経路固有例外を LLMError に変換する。
 *
 * SDK 非依存に保つ（openai 等の経路固有例外→LLMError の写像は各アダプタの責務）。retryable は呼び出し側の
 * リトライ判断材料（C-17-6：抽象化レイヤーはリトライしない）。
 */

export type LLMErrorCode =
  | 'AUTHENTICATION' // 認証失敗（API キー不正・期限切れ・スコープ不足）
  | 'RATE_LIMIT' // レート制限
  | 'QUOTA_EXCEEDED' // クォータ超過
  | 'TIMEOUT' // タイムアウト
  | 'INVALID_REQUEST' // バリデーションエラー（不正なメッセージ構造・トークン数超過等）
  | 'CONTENT_FILTERED' // モデル側のコンテンツフィルタ発動
  | 'MODEL_NOT_FOUND' // 指定モデルが存在しない／経路で未対応
  | 'NOT_IMPLEMENTED' // 経路アダプタで未実装の機能
  | 'NETWORK' // ネットワークエラー（接続不可・DNS 失敗等）
  | 'INTERNAL'; // その他

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly backend: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
  readonly requestId?: string;

  constructor(args: {
    code: LLMErrorCode;
    message: string;
    backend: string;
    retryable?: boolean;
    cause?: unknown;
    requestId?: string;
  }) {
    super(args.message);
    this.name = 'LLMError';
    this.code = args.code;
    this.backend = args.backend;
    this.retryable = args.retryable ?? false;
    this.cause = args.cause;
    this.requestId = args.requestId;
  }
}

export function isLLMError(error: unknown): error is LLMError {
  return error instanceof LLMError;
}

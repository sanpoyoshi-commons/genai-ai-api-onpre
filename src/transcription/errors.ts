/**
 * 文字起こしの統一エラー型（LLMError／ImageError と対称）。
 *
 * SDK／HTTP 非依存に保つ（経路固有例外→TranscriptionError の写像は adapter の責務）。retryable は worker の
 * 再配信判断の材料：true は一過性（接続・タイムアウト・5xx・レート）で再配信、false は恒久（不正音声・モデル不在）
 * で FAILED 確定（無限リトライ回避）。
 */

export type TranscriptionErrorCode =
  | 'INVALID_AUDIO' // 音声が不正・空・未対応形式（恒久）
  | 'MODEL_NOT_FOUND' // 指定モデルがバックエンドに無い（恒久）
  | 'TIMEOUT' // 文字起こしがタイムアウト（一過性）
  | 'NETWORK' // バックエンド接続不可（一過性）
  | 'RATE_LIMIT' // レート制限（一過性）
  | 'TRANSCRIPTION_FAILED' // バックエンドがエラー応答（status 依存で分類）
  | 'INTERNAL'; // その他

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  readonly backend: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(args: {
    code: TranscriptionErrorCode;
    message: string;
    backend: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'TranscriptionError';
    this.code = args.code;
    this.backend = args.backend;
    this.retryable = args.retryable ?? false;
    this.cause = args.cause;
  }
}

export function isTranscriptionError(error: unknown): error is TranscriptionError {
  return error instanceof TranscriptionError;
}

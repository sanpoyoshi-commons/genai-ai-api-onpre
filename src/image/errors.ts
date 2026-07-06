/**
 * 画像生成の統一エラー型（LLMError と対称、ImageClient 実配線）。
 *
 * SDK／HTTP 非依存に保つ（経路固有例外→ImageError の写像は adapter の責務、HTTP status への写像はルート層の
 * 責務）。code はルートで HTTP status に写像する（MODE_NOT_SUPPORTED/MODEL_NOT_LOADED→501、INVALID_REQUEST→400、
 * その他→5xx）。
 */

export type ImageErrorCode =
  | 'MODE_NOT_SUPPORTED' // 要求モードが sd.cpp/SD 系に存在しない（color-guided/background-removal/outpainting/maskPrompt）
  | 'MODEL_NOT_LOADED' // バックエンドに必要モデル（inpaint/ControlNet 等）が未ロード
  | 'INVALID_REQUEST' // 入力検証エラー（必須欠落・不正パラメータ）
  | 'TIMEOUT' // ポーリングがタイムアウト
  | 'GENERATION_FAILED' // ジョブが failed/cancelled で終了
  | 'NETWORK' // バックエンド接続不可
  | 'INTERNAL'; // その他

export class ImageError extends Error {
  readonly code: ImageErrorCode;
  readonly backend: string;
  readonly cause?: unknown;

  constructor(args: { code: ImageErrorCode; message: string; backend: string; cause?: unknown }) {
    super(args.message);
    this.name = 'ImageError';
    this.code = args.code;
    this.backend = args.backend;
    this.cause = args.cause;
  }
}

export function isImageError(error: unknown): error is ImageError {
  return error instanceof ImageError;
}

/**
 * サンドボックス到達エラー（HttpSandboxClient が throw する）。
 *
 * コード実行の失敗（非0終了・wall-time 超過）は SandboxExecResult.status で表し throw しない。
 * ここで扱うのは「サンドボックスサービスに到達できない/応答が不正」という transport/protocol 層の失敗で、
 * 呼び出し側（route ハンドラ）は 500 に写像する（源内 IF は 400/500 のみ規定）。
 */
export type SandboxErrorCode =
  /** 接続不能（fetch failed＝サービス未起動/ネットワーク不通）。 */
  | 'down'
  /** HTTP 呼び出しがクライアント側タイムアウトに達した。 */
  | 'timeout'
  /** HTTP 非2xx / 不正な JSON 等のプロトコル不整合。 */
  | 'protocol'
  /** 出力が上限超過（防御）。 */
  | 'oversize';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly requestId?: string;

  constructor(code: SandboxErrorCode, message: string, options?: { cause?: unknown; requestId?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SandboxError';
    this.code = code;
    this.requestId = options?.requestId;
  }
}

export function isSandboxError(error: unknown): error is SandboxError {
  return error instanceof SandboxError;
}

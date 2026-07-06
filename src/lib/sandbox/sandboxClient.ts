/**
 * サンドボックス実行の seam（任意 Python コードの隔離実行）。
 *
 * Code Interpreter は ①コード生成（LLM がコードを書く）と ②実行（隔離環境で走らせる）の 2 部品から成る。
 * 源内オリジナルは AOAI managed code_interpreter に①②を一体委譲していたが、ローカル化版は①を
 * LLM 抽象化レイヤー（LlmClient）に、②を別コンテナの NsJail サンドボックス（HTTP サービス）に分離する。
 * この seam は②の最小契約（コード文字列＋入力ファイル → stdout/stderr＋生成ファイル＋実行状態）を定義する。
 * unit テストは fake を注入する。実装は HttpSandboxClient（NsJail コンテナへの HTTP 委譲）。
 *
 * セキュリティ上の前提：**真の隔離境界はサンドボックスコンテナ（NsJail・network off・read-only fs・資源上限）**で
 * あり、ここで受け渡すコード/ファイルは「敵対的入力」とみなす。api 層の入力検証や LLM プロンプトの制約は
 * 多層防御の上層（無駄実行の削減・UX）に過ぎず、隔離の保証ではない。
 */

/** サンドボックスへ渡す入力ファイル（分析対象 CSV/Excel 等）。 */
export interface SandboxInputFile {
  /** ファイル名（作業ディレクトリ内の basename）。 */
  name: string;
  /** ファイル本体。 */
  bytes: Buffer;
}

/** サンドボックス実行入力。 */
export interface SandboxExecInput {
  /** 実行する Python コード（LLM 生成）。 */
  code: string;
  /** 作業ディレクトリへ展開する入力ファイル。 */
  files: SandboxInputFile[];
  /** サンドボックス側の wall-time 上限（ms）。サンドボックスへ timeout_ms として渡す。 */
  timeoutMs: number;
  /** 回収する生成ファイルの glob（既定 ['*.png']＝チャート画像）。 */
  outputGlobs?: string[];
  /** リクエスト識別子（トレース用）。 */
  requestId: string;
}

/** 実行ステータス。ok=正常終了、error=非0終了/例外、timeout=サンドボックス側 wall-time 超過。 */
export type SandboxStatus = 'ok' | 'error' | 'timeout';

/** サンドボックスが生成したファイル（チャート PNG 等）。 */
export interface SandboxOutputFile {
  name: string;
  bytes: Buffer;
}

/**
 * サンドボックス実行結果。`status` が error/timeout でも（＝コード実行が失敗しても）これは正常な
 * 返り値で、orchestrator が再試行判断に使う。サンドボックスへの到達失敗（接続不能・HTTP エラー・
 * HTTP タイムアウト・不正レスポンス）は SandboxError として throw される（execute の契約）。
 */
export interface SandboxExecResult {
  status: SandboxStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  files: SandboxOutputFile[];
}

export interface SandboxClient {
  /**
   * コードを隔離実行する。コード実行の成否は SandboxExecResult.status で表す（throw しない）。
   * サンドボックスへの到達失敗のみ SandboxError を throw する。
   */
  execute(input: SandboxExecInput): Promise<SandboxExecResult>;
}

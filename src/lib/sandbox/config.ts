/**
 * Code Interpreter / サンドボックスの設定（env 読取）。
 *
 * SANDBOX_BASE_URL は使用時にのみ必須（未設定でも app は起動可＝seam 未配線と同挙動、idp/config と同方式）。
 * 数値上限は個人開発者が env 1 行で調整できる。コード生成 LLM のモデル解決は models.ts（resolveCodeInterpreterModel）が担う。
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** orchestrator / route が参照する実行制御。 */
export interface CodeInterpreterConfig {
  /** サンドボックス側 wall-time 上限（ms）。サンドボックスへ timeout_ms として渡す。 */
  execTimeoutMs: number;
  /** 試行回数の上限（初回＋再試行）。既定 3＝初回＋2 リトライ。最小 1（＝単発）。 */
  maxAttempts: number;
  /** 入力ファイル合計サイズの上限（byte）。超過は 400。 */
  maxTotalFileBytes: number;
}

export function loadCodeInterpreterConfig(): CodeInterpreterConfig {
  return {
    execTimeoutMs: intEnv('CODE_INTERPRETER_TIMEOUT_MS', 60000),
    maxAttempts: Math.max(1, intEnv('CODE_INTERPRETER_MAX_ATTEMPTS', 3)),
    maxTotalFileBytes: intEnv('CODE_INTERPRETER_MAX_FILE_BYTES', 25 * 1024 * 1024),
  };
}

/** HttpSandboxClient が参照する接続設定。 */
export interface SandboxClientConfig {
  /** サンドボックスのベース URL（/eval は付けない。例 http://sandbox:8080）。 */
  baseUrl: string;
  /** HTTP 呼び出しのタイムアウト（ms）。サンドボックス側 wall-time ＋バッファで、HTTP 層が先に切れないようにする。 */
  timeoutMs: number;
  /** 注入用 fetch（unit はモック注入）。未指定はグローバル fetch。 */
  fetch?: typeof fetch;
}

export function loadSandboxClientConfig(): SandboxClientConfig {
  const baseUrl = process.env.SANDBOX_BASE_URL;
  if (!baseUrl) {
    throw new Error('SANDBOX_BASE_URL is not set');
  }
  const execTimeoutMs = intEnv('CODE_INTERPRETER_TIMEOUT_MS', 60000);
  // HTTP タイムアウトは exec 上限＋5s。サンドボックスは exec 上限内に必ず応答する設計のため、
  // HTTP 層のタイムアウト（SandboxError timeout）は本来「サンドボックスが固まった/不通」のときだけ起きる。
  return { baseUrl: baseUrl.replace(/\/+$/, ''), timeoutMs: execTimeoutMs + 5000 };
}

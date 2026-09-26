/**
 * 判定ルート（POST /api/judge）の設定（env 読取・-onpre 新規）。
 *
 * 既存 LLM 経路（OpenAI 互換・`OLLAMA_BASE_URL`）とは別経路：Ollama の OpenAI 互換 API は
 * logprobs を返さないため、判定はネイティブ `/api/chat` を直接叩く（`JUDGE_OLLAMA_URL` は
 * `/v1` を含まないベース URL）。既定モデルは既定チャットモデルと同一にして、
 * `OLLAMA_MAX_LOADED_MODELS=1` 環境でのモデル入れ替え（読み込み待ち・キャッシュ消失）を避ける。
 *
 * lazy 読込（apiRouter が起動時に 1 度呼ぶが、モデル未設定でも例外にせず route 実行時に 503 とする）。
 */

/**
 * 応答 1 トークン目の候補をどれだけ受け取るか。
 *
 * Ollama `/api/chat` の `top_logprobs` が受ける最大値が 20 で、**これが choice の選択肢数の上限
 * （MAX_CHOICES）を決めている**：候補が 21 件あると上位 20 件しか確率が返らず、21 件目以降は
 * 確率が測れない（黙って 0 として扱われる）。常に上限いっぱいを要求して取りこぼしを避ける。
 */
export const JUDGE_TOP_LOGPROBS = 20;

/**
 * コンテキスト長のうち、プロンプト以外に見積もる予約トークン数。
 * チャットテンプレートの制御トークン・生成 1 トークン・見積もり誤差の緩衝。
 */
export const JUDGE_RESERVE_TOKENS = 250;

/** リトライ方針（判定は冪等なので安全に再試行できる）。 */
export const JUDGE_MAX_RETRIES = 2;
export const JUDGE_RETRY_BASE_DELAY_MS = 500;
export const JUDGE_RETRY_MAX_DELAY_MS = 5000;
export const JUDGE_RETRY_JITTER = 0.25;

export interface JudgeConfig {
  /** Ollama ネイティブ API のベース URL（`/api/chat` は付けない。例 http://ollama:11434）。 */
  baseUrl: string;
  /** 既定モデル。未設定なら判定ルートだけ 503（他の機能は壊さない）。 */
  defaultModel?: string;
  /** 許可モデル。未設定なら既定モデルのみ許可。 */
  allowedModels: string[];
  /**
   * コンテキスト長。切り詰め検知の基準で、**実際の ollama の設定以下でなければ意味を成さない**
   * （大きく見積もると、切り詰められる入力を通してしまう）。
   */
  contextLength: number;
  /** state の上限バイト数。超過は 400。 */
  maxStateBytes: number;
  /**
   * 上流呼び出し 1 回（fetch 1 回）のタイムアウト（ms）。
   *
   * 既定 300 秒は実測に基づく（2026-09-22 実機・本番経路のコールドスタート 6 回）。内訳に注意：
   *
   *  - 端から端までの最大は 166.13 秒だが、**これは単一試行の所要ではない**。150 秒で 1 回目の
   *    試行が打ち切られ、約 15 秒の再試行が成功した合計値である（6 回中 2 回がこの形。上流ログに
   *    `cancel task` と 2 本目の呼び出しが残っている）。打ち切ったので単一試行は測れていない。
   *  - **単一試行の最悪は約 153 秒と推定**＝モデル読み込み 139.34 秒（上流ログの実測値）＋
   *    プロンプト処理 約 14 秒（同条件で完走した回の差分）。300 秒の安全率は約 2.0 になる。
   *  - **再試行はプロンプトキャッシュを引き継げず**、そのプロンプト処理を丸ごと払い直す
   *    （上流ログ `forcing full prompt re-processing`）。再試行があるから短くして良いとは言えない。
   *
   * **短くするとコールドスタートが必ず落ちる。**
   */
  attemptTimeoutMs: number;
  /**
   * リクエスト全体（全問・リトライ・待機を含む）の予算（ms）。使い切ったら 504。
   *
   * 既定 600 秒。**attemptTimeoutMs と独立には決められない**：attempt を上げて budget を据え置くと
   * budget が先に落ち、attempt のタイムアウトが一度も発火しなくなる（設定が死ぬ）。180 秒では
   * コールドスタート 1 問が再試行込みで 166 秒かかった実測に対し予算の 92% を使い切り、そこから
   * 先の再試行の余地がゼロになる。600 秒なら 300 秒の試行が 1 回落ちても再試行が 1 回入る。
   * **壊れた上流に張り付く最長時間を決めるのは
   * budget ではなく attemptTimeoutMs × 試行回数**であり、600 はその器にすぎない。
   */
  requestBudgetMs: number;
  /**
   * リトライ待機の上限（ms）。上流が Retry-After でこれを超える待機を指示したら、
   * 待たずにその場で失敗させる（壊れた上流によるハンドラ内の滞留を防ぐ）。
   */
  maxRetryWaitMs: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function loadJudgeConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  // 既定モデルは JUDGE_DEFAULT_MODEL →（無ければ）既定チャットモデルへ委譲。
  const defaultModel = env.JUDGE_DEFAULT_MODEL?.trim() || env.OLLAMA_DEFAULT_CHAT_MODEL?.trim() || undefined;
  const allowed = listEnv(env, 'JUDGE_ALLOWED_MODELS');
  return {
    baseUrl: (env.JUDGE_OLLAMA_URL?.trim() || 'http://ollama:11434').replace(/\/+$/, ''),
    defaultModel,
    // 許可リスト未設定なら既定モデルのみ許可（素通しにはしない＝資源枯渇・意図しないモデル入れ替えの防止）。
    allowedModels: allowed.length > 0 ? allowed : defaultModel ? [defaultModel] : [],
    // JUDGE_CONTEXT_LENGTH →（無ければ）deploy が ollama へ渡している OLLAMA_CONTEXT_LENGTH へ追従 →
    // どちらも無ければ 8192。ollama 側が 4096 で動いているのに判定側が 8192 だと思い込むと、
    // 切り詰め検知が素通りして「黙って切り詰められた入力で判定する」事故になるため、既定は実設定に揃える。
    contextLength: intEnv(env, 'JUDGE_CONTEXT_LENGTH', intEnv(env, 'OLLAMA_CONTEXT_LENGTH', 8192)),
    maxStateBytes: intEnv(env, 'JUDGE_MAX_STATE_BYTES', 8192),
    attemptTimeoutMs: intEnv(env, 'JUDGE_ATTEMPT_TIMEOUT_MS', 300000),
    requestBudgetMs: intEnv(env, 'JUDGE_REQUEST_BUDGET_MS', 600000),
    maxRetryWaitMs: intEnv(env, 'JUDGE_MAX_RETRY_WAIT_MS', 60000),
  };
}

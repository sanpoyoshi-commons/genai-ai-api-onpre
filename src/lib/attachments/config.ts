/**
 * 添付の取り出しの上限（env）。
 *
 * 既定値は `OLLAMA_CONTEXT_LENGTH=8192` を前提にした初期値。文脈長を超えると
 * Ollama は入力を黙って切り詰めるため、先頭の注意書きが落ちないよう余白を残す側に倒している。
 * 既定値を `OLLAMA_CONTEXT_LENGTH` から自動で導かない（判定の `JUDGE_CONTEXT_LENGTH` と同じ流儀で、
 * compose のコメントで連動を促す）。api は実バックエンドの文脈長を知らないため。
 */

export interface AttachmentLimits {
  /** 1件あたりの文字数の上限。超えたら先頭から切り `truncated="true"`。 */
  maxChars: number;
  /** 1メッセージの添付の合計文字数の上限。 */
  totalMaxChars: number;
  /** PDF のページ数の上限。 */
  maxPages: number;
  /** base64 を復号した後のバイト数の上限。超えたら解析せず注記だけ。 */
  maxBytes: number;
  /**
   * 1メッセージで解析する**文書**の件数の上限（web の `FILE_LIMIT.maxFileCount` と揃える）。
   * **画像は数えない**（`maxImages` が別に数える）。web が文書と画像を別枠で数えるため。
   */
  maxFiles: number;
  /** 1リクエスト（送る会話の全体）でモデルへ渡す**画像**の枚数の上限（web の maxImageFileCount と揃える）。 */
  maxImages: number;
  /** 1件あたりの解析の打ち切り時間（ms）。 */
  parseTimeoutMs: number;
  /** 取り出し結果のメモ化の件数の上限（LRU）。 */
  cacheEntries: number;
}

/**
 * コード内の既定値。**deploy の compose の既定値と同じ数にすること**（2026-09-27 の決定）。
 * どれも10進の整数で書く（`5 * 1024 * 1024` のような式にしない＝compose の値とそのまま突き合わせられる）。
 */
export const ATTACHMENT_LIMIT_DEFAULTS: AttachmentLimits = {
  maxChars: 5000,
  totalMaxChars: 5000,
  maxPages: 20,
  maxBytes: 5242880,
  maxFiles: 5,
  maxImages: 3,
  parseTimeoutMs: 10000,
  cacheEntries: 32,
};

/**
 * `JUDGE_MAX_STATE_BYTES` と同じ読み取り（`src/lib/judge/config.ts` の intEnv と同一の実装）。
 * 未設定・空文字・0 以下は既定へ落とす（上限を env の書き間違いで外さない）。
 */
function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadAttachmentLimits(env: NodeJS.ProcessEnv = process.env): AttachmentLimits {
  const d = ATTACHMENT_LIMIT_DEFAULTS;
  return {
    maxChars: intEnv(env, 'ATTACHMENT_MAX_CHARS', d.maxChars),
    totalMaxChars: intEnv(env, 'ATTACHMENT_TOTAL_MAX_CHARS', d.totalMaxChars),
    maxPages: intEnv(env, 'ATTACHMENT_MAX_PAGES', d.maxPages),
    maxBytes: intEnv(env, 'ATTACHMENT_MAX_BYTES', d.maxBytes),
    maxFiles: intEnv(env, 'ATTACHMENT_MAX_FILES', d.maxFiles),
    // 画像は文字の予算も文書の件数も食わないので、枚数で別に絞る（文脈長と body の両方に効く）。
    maxImages: intEnv(env, 'ATTACHMENT_MAX_IMAGES', d.maxImages),
    parseTimeoutMs: intEnv(env, 'ATTACHMENT_PARSE_TIMEOUT_MS', d.parseTimeoutMs),
    // メモ化の件数の上限（無くせない安全弁）。compose 側の環境変数にも配線済み。
    cacheEntries: intEnv(env, 'ATTACHMENT_CACHE_ENTRIES', d.cacheEntries),
  };
}

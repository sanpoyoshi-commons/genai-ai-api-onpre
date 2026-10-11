/**
 * ナレッジ集の投入の上限（env）。
 *
 * チャットの添付（`ATTACHMENT_*`）とは別に持つ（`KNOWLEDGE_*`）。添付の上限は「モデルの文脈長に収まるか」で
 * 決めるので小さいが、ナレッジ集は文書全体を切って貯め、問うときは上位のチャンクだけを渡すので、
 * 文書そのものはもっと大きくてよい。
 *
 * **添付と違い、上限を超えたら切り詰めずに投入を断る**（2026-10-10 の決定）。ナレッジ集で文書の後半が
 * 黙って欠けると、検索で見つからずに「参考情報からは確認できません」になり、原因が利用者から見えない。
 *
 * 添付の `ATTACHMENT_MAX_FILES`・`ATTACHMENT_MAX_IMAGES`・`ATTACHMENT_CACHE_ENTRIES` に当たる上限は持たない。
 * 投入は 1 回に 1 文書、画像は受け付けない（文字が取れない）、取り出しの結果はメモ化しない（同じ原本を
 * 読み直す経路が無い）。
 */

export interface KnowledgeLimits {
  /** 原本 1 件のバイト数の上限。超えたら投入を断る。 */
  maxBytes: number;
  /** 抽出したテキストの文字数の上限。超えたら投入を断る（切り詰めない）。 */
  maxChars: number;
  /** PDF のページ数の上限。超えたら投入を断る。 */
  maxPages: number;
  /** 1 件あたりの解析の打ち切り時間（ms）。超えたら投入を断る。 */
  parseTimeoutMs: number;
  /** 1 文書あたりのチャンク数の上限。超えたら投入を断り、文書を作らない。 */
  maxChunks: number;
}

/**
 * コード内の既定値。**deploy の compose の既定値と同じ数にすること**（添付の `ATTACHMENT_*` と同じ流儀）。
 * どれも 10 進の整数で書く（`20 * 1024 * 1024` のような式にしない＝compose の値とそのまま突き合わせられる）。
 * どの値も仮置きで、実測で見直す。
 *
 * - `maxChunks` 300：1 文書の投入にかかる時間が nginx の読み取りの待ち時間に収まる見込みの数。
 * - `maxChars` 300000：`maxChunks` 300 × 既定のチャンクの大きさ 1000 文字の目安。
 * - `maxBytes` 20971520（20MiB）：添付（5MiB）より大きい文書を見込んだ余裕。
 * - `maxPages` 300：ページ数の多い PDF を見込んだ値。
 * - `parseTimeoutMs` 120000：添付（10 秒）の 12 倍。大きい PDF を見込んだ値。
 */
export const KNOWLEDGE_LIMIT_DEFAULTS: KnowledgeLimits = {
  maxBytes: 20971520,
  maxChars: 300000,
  maxPages: 300,
  parseTimeoutMs: 120000,
  maxChunks: 300,
};

/** `ATTACHMENT_*` と同じ読み取り。未設定・空文字・0 以下は既定へ落とす（env の書き間違いで上限を外さない）。 */
function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadKnowledgeLimits(env: NodeJS.ProcessEnv = process.env): KnowledgeLimits {
  const d = KNOWLEDGE_LIMIT_DEFAULTS;
  return {
    maxBytes: intEnv(env, 'KNOWLEDGE_MAX_BYTES', d.maxBytes),
    maxChars: intEnv(env, 'KNOWLEDGE_MAX_CHARS', d.maxChars),
    maxPages: intEnv(env, 'KNOWLEDGE_MAX_PAGES', d.maxPages),
    parseTimeoutMs: intEnv(env, 'KNOWLEDGE_PARSE_TIMEOUT_MS', d.parseTimeoutMs),
    maxChunks: intEnv(env, 'KNOWLEDGE_MAX_CHUNKS', d.maxChunks),
  };
}

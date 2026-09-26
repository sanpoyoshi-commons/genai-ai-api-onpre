import { z } from 'zod';

/**
 * 判定ルート（POST /api/judge）の入力スキーマ（-onpre 新規）。
 *
 * api は判定定義を持たない（問いは毎回リクエストで渡される）ため、**上限はここで全部掛ける**。
 * 資源枯渇（問いの数だけ推論が走る）と、コンテキスト長の逼迫を入口で止める。
 * state のバイト上限だけは env 依存のため JudgeService 側（400）で検査する。
 */

/** 問い名。gwr のフロー TOML のキーをそのまま使うため、識別子として安全な文字に限る。 */
const QUESTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 1 リクエストの問い数上限（問いの数だけ逐次に推論が走る）。 */
export const MAX_QUESTIONS = 16;
/**
 * choice の選択肢数。上限 20 の理由は**記号の文字数ではなく `top_logprobs` の上限**：
 * Ollama `/api/chat` は 0〜20 しか受けないため、候補が 21 件あると上位 20 件の確率しか返らず、
 * 21 件目以降は測れない（確率 0 として黙って扱われる）。→ JUDGE_TOP_LOGPROBS と対で動かす。
 */
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 20;
/** score の段階数（0〜9）。 */
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/**
 * 説明・問い文の入れ子の深さ上限。
 *
 * **なぜ要るか**：オブジェクト／配列は `JSON.stringify(値, null, 2)` で文字列化するため、
 * 深い入れ子ほど**各行のインデントが深さに比例して伸びる**＝入力長に対して出力が非線形に膨らむ。
 * 膨らんだ結果は 422 判定（プロンプト全体のバイト上界）で弾かれるが、**弾く前に文字列化の費用は
 * 払ってしまう**ため、入口で深さを止める。
 *
 * **なぜ 8 か**：構造化記法の想定は「選択肢ごとに what／not_for／examples を書く」程度で、
 * 実際の入れ子は 2〜3 段（オブジェクト → 配列 → 文字列）に収まる。8 段は十分な余裕がありつつ、
 * インデント膨張を実用的な範囲に抑える。**この上限で従来通っていた入力が落ちることはない**
 * （従来は文字列と null しか受けていなかったため、入れ子のある入力は存在しない）。
 */
export const MAX_ENTRY_DEPTH = 8;

/**
 * JSON で表せる値か、入れ子が上限内かを検査する。
 * `depth` は「今見ている値がいくつの入れ物の中にあるか」（値そのものは 0）。
 */
function isJsonWithinDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    // NaN / Infinity は JSON.stringify が null にしてしまうため受けない。
    return Number.isFinite(value);
  }
  if (depth >= MAX_ENTRY_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((v) => isJsonWithinDepth(v, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every((v) => isJsonWithinDepth(v, depth + 1));
  }
  // undefined・関数・Symbol・BigInt。HTTP 経由（express.json）では現れないが、直接呼び出しに備える。
  return false;
}

/**
 * 構造化の説明（オブジェクト／配列）。**フィールド名は予約語ではなく呼び出し側が決める**
 * （モデルは名前と値の両方を読む）。似た選択肢を書き分けるための記法で、本家 SDK の EntryType に揃える。
 */
const structuredEntry = z.custom<Record<string, unknown> | unknown[]>(
  (v) => (Array.isArray(v) || (typeof v === 'object' && v !== null)) && isJsonWithinDepth(v, 0),
  `オブジェクト／配列は JSON で表せる値のみ・入れ子は ${MAX_ENTRY_DEPTH} 段までです`,
);

/**
 * 問い文。文字列・オブジェクト・配列を受ける（本家 SDK の EntryType と同じ形）。
 * **`null` は受けない**（説明の無い問いは成り立たない）。state と同じ方針。
 */
const instructions = z.union([z.string().trim().min(1, 'instructions は必須です'), structuredEntry], {
  error: `instructions は空でない文字列・オブジェクト・配列のいずれかです（null 不可・入れ子は ${MAX_ENTRY_DEPTH} 段まで）`,
});

/**
 * 選択肢・段階の説明。文字列・オブジェクト・配列・`null` を受ける（本家 SDK の EntryType と同じ形）。
 * `null` は「説明を付けない選択肢」を表す正当な入力である。
 */
const entry = z.union([z.string().trim().min(1, 'criteria の要素は空文字にできません'), z.null(), structuredEntry], {
  error: `criteria の要素は文字列・オブジェクト・配列・null のいずれかです（空文字不可・入れ子は ${MAX_ENTRY_DEPTH} 段まで）`,
});

/**
 * choice の criteria は 2 形式を受ける。
 *  - 配列：説明だけを順に並べる（ラベルは `A`〜 が自動で振られ、応答もその記号で返る）。
 *  - オブジェクト：キーが呼び出し側のラベル・値が説明（`null` 可）。応答の choice／probabilities は
 *    **そのキー**で返す（プロンプト上は `A`〜 に割り当てて 1 トークンで答えさせる）。
 * 上限は 20 件。本家の仕様上限は 255 だが、**`top_logprobs` の上限が 20** のため、21 件以上は
 * 上位 20 件しか確率が返らず、21 件目以降の確率を測れない（→ 黙って 0 になる）。記号の文字数は
 * 制約ではない（A〜Z で 26 件ぶんある）。上限を上げるには分布の取り方そのものを変える必要がある。
 */
const choiceCriteria = z.union([
  z
    .array(entry)
    .min(MIN_CHOICES, `choice の criteria は ${MIN_CHOICES}〜${MAX_CHOICES} 件です`)
    .max(MAX_CHOICES, `choice の criteria は ${MIN_CHOICES}〜${MAX_CHOICES} 件です`),
  z
    .record(z.string().trim().min(1, 'criteria のラベルは空にできません').max(64), entry)
    .refine(
      (v) => Object.keys(v).length >= MIN_CHOICES && Object.keys(v).length <= MAX_CHOICES,
      `choice の criteria は ${MIN_CHOICES}〜${MAX_CHOICES} 件です`,
    ),
]);

const noulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions,
});

const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions,
  criteria: choiceCriteria,
});

const scoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions,
  // score は本家の型が最低 2 要素のタプルなので配列形式のみ（段階に呼び出し側のラベルは付けない）。
  // 各要素は instructions と同じ EntryType（文字列・オブジェクト・配列・null）。
  criteria: z
    .array(entry)
    .min(MIN_SCORE_LEVELS, `score の criteria は ${MIN_SCORE_LEVELS}〜${MAX_SCORE_LEVELS} 段です`)
    .max(MAX_SCORE_LEVELS, `score の criteria は ${MIN_SCORE_LEVELS}〜${MAX_SCORE_LEVELS} 段です`),
});

export const judgeQuestionSchema = z.discriminatedUnion('type', [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

export const judgeSchema = z.object({
  /** 使用モデル（任意）。許可リスト照合は JudgeService（許可外は 400）。 */
  model: z.string().trim().min(1, 'model は空にできません').optional(),
  /**
   * 判定対象。文字列・オブジェクト・配列のいずれか（オブジェクト/配列は JSON 化して渡す）。
   * `null` は**受け付けない**（検証失敗＝400）。本家は SDK 間で扱いが割れている（JS は許可・Python は拒否）ため、
   * こちらは拒否で固定する：判定対象なしで判定させる設計は採らない。
   */
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())], {
    error: 'state は文字列・オブジェクト・配列のいずれかです（null は指定できません）',
  }),
  /** 問い（問い名 → 定義）。 */
  questions: z
    .record(z.string().regex(QUESTION_NAME_PATTERN, '問い名は ^[A-Za-z0-9_-]{1,64}$ に一致する必要があります'), judgeQuestionSchema)
    .refine((q) => Object.keys(q).length >= 1, '問いを 1 つ以上指定してください')
    .refine((q) => Object.keys(q).length <= MAX_QUESTIONS, `問いは ${MAX_QUESTIONS} 個までです`),
});

export type JudgeBody = z.infer<typeof judgeSchema>;

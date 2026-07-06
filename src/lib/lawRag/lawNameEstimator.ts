import { readFileSync } from 'node:fs';
import type { LlmClient } from '../llm/llmClient.js';
import { logger } from '../logger.js';

/**
 * 法令名推定（移植元 law_report_pipeline._estimate_law_names の on-prem 移植）。
 *
 * 移植元はクエリを Gemini＋Google 検索 grounding に渡し、関連する**法令名**を JSON
 * `{"law_names":[...]}` で抽出する（これが recall の肝）。on-prem は web 検索が無いため、
 * **ローカル LLM（gemma 等）の知識のみ**で同タスクを行う。よって prompt は移植元の
 * web 前提文言（e-Gov/.go.jp 参照・最新情報確認・today_str）を除去し、gemma 向けに作り直す。
 * アーキ（クエリ→法令名 JSON）は忠実、prompt は実行環境に最適化する方針。
 *
 * 知識カットオフ起因の取りこぼし（学習後の改正・新法）は web 無しの構造的限界として許容する。
 * 出力 JSON の揺れ（```囲み・前置き・マークダウン羅列）は移植元の 4 段フォールバックを踏襲して吸収する。
 * prompt 品質は law_queries.json の law 欄を正解にした eval で詰める（初版＝下記 たたき台）。
 */

/** gemma 向け法令名推定システムプロンプト（web grounding 非依存・初版。eval で調整する）。 */
export const LAW_NAME_SYSTEM_PROMPT = `あなたは日本の法令に精通したアシスタントです。ユーザーの質問に関連する「現行の日本の法令名」を、あなた自身の知識に基づいて推定してください。

制約:
- 廃止・統合された法令は挙げず、現行の後継法令名のみを挙げる（例:「行政機関個人情報保護法」→「個人情報の保護に関する法律」）。
- 通称・略称で言及された場合、正式名称が確実に分かるものだけを正式名称で挙げる。正式名称が不確実、または実在が確認できない法令は挙げない（推測で実在しない法令名を作らない）。
- 確信が持てなければ無理に挙げない。思い当たらなければ空配列でよい。
- 関連度の高い順に最大 10 件。

出力形式:
- 有効な JSON のみを 1 行で出力する。説明文・前置き・マークダウン・思考過程は一切含めない。
- 形式: {"law_names": ["正式名称1", "正式名称2"]}`;

// クエリ中の法令名らしき表記（移植元 _QUERY_LAW_NAME_PATTERN）。
const QUERY_LAW_NAME_PATTERN = /[一-龥ァ-ヴー]+(?:法律|法|規則|政令|条例|省令)/g;

const MAX_LAW_NAMES = 10;

// ---- 純関数（LLM / ネットワーク不要・ユニットテスト対象） --------------------------------

/** LLM 応答テキストから law_names を抽出する。移植元 _estimate_law_names の 4 段フォールバックを移植。 */
export function parseLawNames(responseText: string): string[] {
  const text = responseText ?? '';

  // Stage 1: 直接 JSON 解析（```json コードブロックの囲みを除去してから）。
  const stripped = text.trim().replace(/^```(?:json)?\s*\n?|```\s*$/g, '');
  try {
    const result = JSON.parse(stripped);
    const names = result?.law_names;
    if (Array.isArray(names)) {
      return cleanNames(names.map(String));
    }
  } catch {
    // 次段へ。
  }

  // Stage 2: 正規表現で JSON 部分を抽出して解析。
  const jsonMatches = text.match(/\{[^{}]*"law_names"[^{}]*\[[^\]]*\][^{}]*\}/gs) ?? [];
  for (const m of jsonMatches) {
    try {
      const result = JSON.parse(m);
      const names = result?.law_names;
      if (Array.isArray(names)) {
        return cleanNames(names.map(String));
      }
    } catch {
      // 次の候補へ。
    }
  }

  // Stage 3: 正規表現で法令名を直接抽出（プレーンテキスト応答）。
  const stage3Patterns = [
    /([^。、\n]*(?:人工知能|AI)[^。、\n]*(?:法|規則|省令|政令|条例)[^。、\n]*)/g,
    /([^。、\n]*(?:法|規則|省令|政令|条例)[^。、\n]*)/g,
  ];
  for (const pattern of stage3Patterns) {
    const matches = [...text.matchAll(pattern)].map((mm) => mm[1] ?? '');
    const names = dedupe(
      matches.map((s) => s.trim()).filter((s) => s.length > 3 && s.length < 50),
    ).slice(0, MAX_LAW_NAMES);
    if (names.length > 0) {
      return names;
    }
  }

  // Stage 4: マークダウン（太字・リスト）から法令名を抽出。
  const stage4Patterns = [
    /\*\*([^*]*(?:法律|法|規則|省令|政令|条例)[^*]*)\*\*/g,
    /\*([^*]*(?:法律|法|規則|省令|政令|条例)[^*]*)\*/g,
    /[*\-]\s*(.+?(?:法律|法|規則|省令|政令|条例)[^\n（(]*)/g,
  ];
  for (const pattern of stage4Patterns) {
    const matches = [...text.matchAll(pattern)].map((mm) => mm[1] ?? '');
    const cleaned: string[] = [];
    for (const raw of matches) {
      const name = raw
        .trim()
        .replace(/\s*[(（].*?[)）]/g, '')
        .replace(/^[ *\-・]+|[ *\-・]+$/g, '');
      if (name.length >= 4 && name.length <= 60) {
        cleaned.push(name);
      }
    }
    if (cleaned.length > 0) {
      return dedupe(cleaned).slice(0, MAX_LAW_NAMES);
    }
  }

  return [];
}

/** クエリから法令名候補を直接抽出する（移植元 _extract_law_names_from_query・4 文字未満の一般語は除外）。 */
export function extractLawNamesFromQuery(query: string): string[] {
  const matches = [...(query ?? '').matchAll(QUERY_LAW_NAME_PATTERN)].map((m) => m[0]);
  return matches.filter((m) => m.length >= 4);
}

/** 通称→正式名称の辞書（キーは正規化済み通称、値は正式名称）。 */
export type LawNameAliases = Readonly<Record<string, string>>;

/** 通称マッチ用の正規化（空白・全角空白・中黒・区切りを除去）。 */
function normalizeAliasKey(name: string): string {
  return (name ?? '').replace(/[\s　・･〔〕（）()]/g, '');
}

/**
 * 通称・略称 → 正式名称の辞書を設定ファイルから解決する（on-prem 追加・リーンプロンプトと同じ機構）。
 *
 * 移植元 Lawsy は web 検索 grounding で通称→正式名称を解決していたが、on-prem は web 無し。gemma は
 * 「労働者派遣法」のような通称を出せても、その通称は正式名称（「労働者派遣事業の適正な運営の確保及び
 * 派遣労働者の保護等に関する法律」）と law_title_embedding が離れ、resolveLawNums の最近傍が**別法を誤って
 * 拾う**（実測：労働者派遣法→昭和四十三年法律第八十九号）。そこで主要法令の標準的略称だけを正式名称へ
 * 決定論的に置換し、正式名称は自分自身に score≈1.0 で確実に解決させる（正式名称→law_num は通常の embedding
 * 解決に委ねる＝全法令名と同一経路）。
 *
 * 辞書データは**コードに持たず**、`LAW_RAG_ALIASES_FILE` で指定した JSON ファイル
 * （`{"通称":"正式名称", ...}`）から**起動時に 1 度だけ**読む（リーンプロンプト LAW_RAG_REPORT_PROMPT_FILE と
 * 同じ流儀）。これにより辞書の増減を**再ビルドなし**（JSON 差し替え＋api 再起動）で行える。キーは読込時に
 * 正規化する（JSON は中黒・空白入りの自然な通称で書ける）。未指定・読めない・不正 JSON のときは空辞書へ安全
 * フォールバックする（誤設定で起動を壊さず、辞書機能だけが無効化＝素の embedding 解決に戻る）。
 *
 * 収録基準（保守スクリプト deploy/scripts/law-alias-verify.mjs が検証）：(1) 社会的に定着した標準略称のみ、
 * (2) 正式名称が app_laws_master.law_title に clean に一意実在（embedding 自己マッチが成立するもののみ）。
 */
export function resolveLawNameAliases(env: NodeJS.ProcessEnv = process.env): LawNameAliases {
  const file = env.LAW_RAG_ALIASES_FILE?.trim();
  if (!file) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn({ file }, 'LAW_RAG_ALIASES_FILE が object でないため辞書を無効化します');
      return {};
    }
    const out: Record<string, string> = {};
    for (const [alias, formal] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof formal !== 'string' || formal.trim().length === 0) {
        logger.warn({ file, alias }, 'LAW_RAG_ALIASES_FILE の値が文字列でないため当該エントリを無視します');
        continue;
      }
      const key = normalizeAliasKey(alias);
      if (key.length > 0) {
        out[key] = formal.trim();
      }
    }
    return out;
  } catch (err) {
    logger.warn(
      { file, error: (err as Error)?.message },
      'LAW_RAG_ALIASES_FILE を読めない/不正 JSON のため辞書を無効化します',
    );
    return {};
  }
}

/**
 * 推定された法令名のうち通称・略称を正式名称へ置換する（順序保持・重複排除）。マッチしない名前は素通し。
 * 置換（追加でなく）にするのは、通称のまま resolveLawNums に渡ると別法を誤って拾うため（その候補を排除する）。
 * 施行令補完（expandLawNamesWithOrdinances）の**前**に適用し、正式名称に施行令・施行規則を付ける。
 * aliases は resolveLawNameAliases で解決した辞書（呼び出し側が起動時に 1 度解決して注入）。
 */
export function applyLawNameAliases(lawNames: string[], aliases: LawNameAliases): string[] {
  const out = lawNames.map((name) => aliases[normalizeAliasKey(name)] ?? name);
  return dedupe(out);
}

/** 法令名に施行令・施行規則を補完する（移植元 _expand_law_names_with_ordinances・順序保持で重複排除）。 */
export function expandLawNamesWithOrdinances(lawNames: string[]): string[] {
  const expanded = [...lawNames];
  for (const name of lawNames) {
    if (name.endsWith('法律') || name.endsWith('法')) {
      expanded.push(`${name}施行令`);
      expanded.push(`${name}施行規則`);
    }
  }
  return dedupe(expanded);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

/** JSON 由来の名前配列を清掃（trim・空除去・重複排除・最大 10 件）。 */
function cleanNames(names: string[]): string[] {
  return dedupe(names.map((n) => n.trim()).filter((n) => n.length > 0)).slice(0, MAX_LAW_NAMES);
}

// ---- 推定器（LlmClient 注入） -----------------------------------------------------------

export class LawNameEstimator {
  constructor(private readonly llm: LlmClient) {}

  /** クエリから現行法令名を推定する（ローカル LLM 知識のみ・web grounding なし）。 */
  async estimate(query: string, model: string, requestId: string): Promise<string[]> {
    const raw = await this.llm.generate({
      model,
      messages: [
        { role: 'system', content: LAW_NAME_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      requestId,
    });
    return parseLawNames(raw);
  }
}

import {
  egovUrl,
  enforceDateFromLawId,
  type ArticleWithSummary,
  type FullArticle,
} from '../../repositories/lawRetriever.js';

/**
 * 法令レポートの出典・引用処理（移植元 report_utils.py /
 * law_report_pipeline._build_references / _to_full_articles / _finalize_report の on-prem 移植）。
 *
 * 引用付きレポート本文の [n] を出典 URL にリンク化し、実際に引用された参照だけを「## 出典」節に並べる。
 *
 * 上流との差分（方針確定 2026-06-06・web/URL 全省略）:
 *   - 参考情報は **e-laws 公式条文（FullArticle）のみ**。移植元の web_hits（Gemini grounding 結果）と
 *     クエリ内 URL fetch は on-prem に web が無いため取り込まない。よって参照型は FullArticle に固定し、
 *     _format_reference の web 分岐・_build_references の web マージは除去する（条文 URL は e-Gov）。
 *   - 引用番号の非連続対応（_build_ref_map の original_index キー）、Mermaid 安全化、citation→link 変換、
 *     citation フィルタは移植元のまま維持する。
 */

/** 参照（on-prem は条文のみ）。 */
export type Reference = FullArticle;

/** (元の引用番号, 参照) のタプル（フィルタ後・非連続番号を保持）。 */
export type IndexedReference = [number, Reference];

const CITATION_GROUP_PATTERN = /\[(\d+(?:,\s*\d+)*)\]/g;
const MERMAID_BLOCK_PATTERN = /```mermaid\n([\s\S]*?)\n```/g;

// ---- 参照フォーマット ------------------------------------------------------------------

/** content/snippet を 1 行化して表示用に正規化する（移植元 _normalize_content）。 */
export function normalizeContent(text: string, maxLen = 200): string {
  return (text ?? '').replace(/\n　*/g, ' ').trim().slice(0, maxLen);
}

/** 施行日プレースホルダの判定しきい値（この年以降は施行日未定扱い＝2117-12-31 等・設計 §5）。 */
export const PLACEHOLDER_ENFORCE_YEAR = 2100;

/** 施行日未定ラベル（政令委任等でプレースホルダ年が入る版・設計 §5）。 */
export const ENFORCE_DATE_UNDECIDED = '施行日未定（政令委任等）';

/** 施行日を表示用に整形する。プレースホルダ年（>=2100）は「施行日未定（政令委任等）」へ変換する。 */
export function formatEnforceDate(date: string | null | undefined): string {
  if (!date) {
    return '';
  }
  const year = Number(date.slice(0, 4));
  if (Number.isFinite(year) && year >= PLACEHOLDER_ENFORCE_YEAR) {
    return ENFORCE_DATE_UNDECIDED;
  }
  return date;
}

/**
 * as-of 版メタを出典/プロンプト用の注記（（施行日: …・未施行・改正予定: … 施行））へ整形する。
 * enforceDate が未設定（as_of 未指定＝既定モード）のときは '' を返す＝as-of 導入前と同一の出典行になる。
 */
export function versionMetaSuffix(r: Reference): string {
  if (r.enforceDate === undefined || r.enforceDate === null) {
    return '';
  }
  const parts: string[] = [];
  const enforce = formatEnforceDate(r.enforceDate);
  if (enforce === ENFORCE_DATE_UNDECIDED) {
    parts.push(enforce);
  } else if (enforce) {
    parts.push(`施行日: ${enforce}`);
  }
  if (r.isFuture) {
    parts.push('未施行');
  }
  if (r.nextEnforceDate) {
    parts.push(`改正予定: ${formatEnforceDate(r.nextEnforceDate)} 施行`);
  }
  return parts.length ? `（${parts.join('・')}）` : '';
}

/** 出典節用の 1 参照フォーマット（番号は i+1・移植元 _format_reference の条文分岐＋as-of 版メタ）。 */
export function formatReference(i: number, r: Reference): string {
  const content = r.content ? normalizeContent(r.content) : '';
  const contentLine = content ? `\n　　> ${content}...` : '';
  const meta = versionMetaSuffix(r);
  return r.url
    ? `[${i + 1}] 🔗 **[${r.title}](${r.url})**${meta}${contentLine}`
    : `[${i + 1}] **${r.title}**${meta}${contentLine}`;
}

/** プロンプト向け 1 参照フォーマット（URL なし・全文・移植元 _format_reference_for_prompt の条文分岐＋as-of 版メタ）。 */
export function formatReferenceForPrompt(i: number, r: Reference): string {
  const meta = versionMetaSuffix(r);
  return `[${i + 1}] 【e-laws公式条文】 ${r.title}${meta ? ` ${meta}` : ''}\n${r.content ?? ''}`;
}

// ---- 変換・マージ ----------------------------------------------------------------------

/** ArticleWithSummary を FullArticle に変換する（content を持つもののみ・移植元 _to_full_articles）。 */
export function toFullArticles(articles: ArticleWithSummary[]): FullArticle[] {
  const out: FullArticle[] = [];
  for (const a of articles) {
    if (a.content) {
      out.push({
        lawId: a.lawId,
        lawNum: a.lawNum, // as-of 版解決のキー。
        lawTitle: a.lawTitle, // 版解決時に条見出しを組み直すため素の法令名を保持する。
        title: a.lawTitle,
        content: a.content,
        uniqueAnchor: a.uniqueAnchor,
        anchor: null,
        url: egovUrl(a.lawId, null),
      });
    }
  }
  return out;
}

/** 参照リストとプロンプト用参考情報テキストを返す（web 省略のため条文のみ・移植元 _build_references）。 */
export function buildReferences(finalArticles: FullArticle[]): {
  searchResults: Reference[];
  referencesText: string;
} {
  const searchResults: Reference[] = finalArticles;
  const referencesText = searchResults
    .map((r, i) => formatReferenceForPrompt(i, r))
    .join('\n\n');
  return { searchResults, referencesText };
}

// ---- 引用処理 --------------------------------------------------------------------------

/** レポート内で実際に引用された参照のみ（元番号保持）を返す（移植元 _filter_references_by_citations）。 */
export function filterReferencesByCitations(
  reportText: string,
  allReferences: Reference[],
): IndexedReference[] {
  const cited = new Set<number>();
  for (const m of (reportText ?? '').matchAll(CITATION_GROUP_PATTERN)) {
    for (const n of m[1]!.split(',')) {
      cited.add(Number(n.trim()));
    }
  }
  return [...cited]
    .sort((a, b) => a - b)
    .filter((i) => i >= 1 && i <= allReferences.length)
    .map((i) => [i, allReferences[i - 1]!] as IndexedReference);
}

/** references（タプル or 素）を {番号: 参照} に変換（移植元 _build_ref_map・original_index キー対応）。 */
function buildRefMap(references: IndexedReference[] | Reference[]): Map<number, Reference> {
  const map = new Map<number, Reference>();
  references.forEach((item, i) => {
    if (Array.isArray(item)) {
      map.set(item[0], item[1]);
    } else {
      map.set(i + 1, item);
    }
  });
  return map;
}

/** 本文中の [n] / [n, m, ...] を出典 URL リンクに変換する（mermaid ブロック内は除外・移植元 convert_citation_to_external_link）。 */
export function convertCitationToExternalLink(
  text: string,
  references: IndexedReference[] | Reference[],
): string {
  const refMap = buildRefMap(references);

  const linkSingle = (num: number): string => {
    const ref = refMap.get(num);
    if (ref && ref.url) {
      return `[[${num}]](${ref.url})`;
    }
    return `[${num}]`;
  };

  // mermaid ブロックの範囲を記録（その中の [n] は変換しない）。
  const mermaidRanges: Array<[number, number]> = [];
  for (const m of (text ?? '').matchAll(MERMAID_BLOCK_PATTERN)) {
    mermaidRanges.push([m.index!, m.index! + m[0].length]);
  }
  const inMermaid = (pos: number): boolean =>
    mermaidRanges.some(([s, e]) => s <= pos && pos <= e);

  return (text ?? '').replace(CITATION_GROUP_PATTERN, (match, inner: string, offset: number) => {
    if (inMermaid(offset)) {
      return match;
    }
    const nums = inner.split(',').map((s) => Number(s.trim()));
    return nums.length === 1 ? linkSingle(nums[0]!) : nums.map((n) => linkSingle(n)).join(' ');
  });
}

// ---- Mermaid 安全化 --------------------------------------------------------------------

const MERMAID_PROTECTED: Array<[string, string]> = [
  ['___ARROW_RIGHT___', '-->'],
  ['___ARROW_LEFT___', '<--'],
  ['___ARROW_BOTH___', '<-->'],
  ['___ARROW_DOTTED___', '-.-'],
  ['___ARROW_THICK___', '==='],
  ['___ARROW_OPEN___', '---'],
  ['___COLON_SPACE___', ': '],
  ['___PIPE_PIPE___', '||'],
  ['___AMP_AMP___', '&&'],
];

const MERMAID_LABEL_REPLACEMENTS: Array<[string, string]> = [
  ['(', '（'],
  [')', '）'],
  ['[', '［'],
  [']', '］'],
  ['{', '｛'],
  ['}', '｝'],
  ['・', '/'],
  ['#', '＃'],
  ['*', '＊'],
  ['"', '“'],
  ["'", '‘'],
  ['<', '＜'],
  ['>', '＞'],
  ['&', '＆'],
  ['\n', '<br>'],
];

function replaceAll(input: string, from: string, to: string): string {
  return input.split(from).join(to);
}

/** Mermaid コードブロック内ノードラベルの危険記号を全角等へ置換し parse エラーを防ぐ（移植元 sanitize_mermaid_content）。 */
export function sanitizeMermaidContent(text: string): string {
  const sanitizeLabel = (label: string): string => {
    let out = label;
    for (const [oldChar, newChar] of MERMAID_LABEL_REPLACEMENTS) {
      out = replaceAll(out, oldChar, newChar);
    }
    return out;
  };

  return (text ?? '').replace(MERMAID_BLOCK_PATTERN, (_full, content: string) => {
    // 1. Mermaid 構文を保護（プレースホルダー化）。
    let protectedContent = content;
    for (const [placeholder, pattern] of MERMAID_PROTECTED) {
      protectedContent = replaceAll(protectedContent, pattern, placeholder);
    }
    // 2-3. ノードラベル（() / [] / {} 内）のみ危険記号を置換。
    let sanitized = protectedContent
      .replace(/\(([^)]+)\)/g, (_m, l: string) => `(${sanitizeLabel(l)})`)
      .replace(/\[([^\]]+)\]/g, (_m, l: string) => `[${sanitizeLabel(l)}]`)
      .replace(/\{([^}]+)\}/g, (_m, l: string) => `{${sanitizeLabel(l)}}`);
    // 4. 保護した Mermaid 構文を復元。
    for (const [placeholder, pattern] of MERMAID_PROTECTED) {
      sanitized = replaceAll(sanitized, placeholder, pattern);
    }
    // 5. 連続空白を正規化（矢印を含む構文行は除く）。
    const lines = sanitized.split('\n').map((line) => {
      if (line.includes('-->') || line.includes('<--') || line.includes('---') || line.includes('===')) {
        return line;
      }
      return line.trim().replace(/\s+/g, ' ');
    });
    return `\`\`\`mermaid\n${lines.join('\n')}\n\`\`\``;
  });
}

// ---- 構造化メタ（as-of・UI バッジ用） -------------------------------------------

/**
 * 引用条文 1 件分の版メタ（API 返却 `references[]` の要素）。レポート本文（markdown）の
 * 「## 出典」と同じ内容を、UI が discrete なバッジとして描けるよう構造化して返す。
 * 焼き込み（markdown）と本メタは同一の filtered 参照から作るため食い違わない。
 */
export interface LawRagReferenceMeta {
  /** 元の引用番号（本文の [n] と対応・非連続を保持）。 */
  n: number;
  /** 出典表示名（法令名＋条見出し・出典節の表記と同一）。 */
  title: string;
  /** e-Gov 法令検索 URL（条文アンカー付き）。 */
  url: string;
  /** 採用した版の施行日 YYYY-MM-DD（不明は null）。>=2100 は施行日未定のプレースホルダ。 */
  enforceDate: string | null;
  /** 未施行フラグ（今日 JST 時点で施行日が未来）。既定モードは索引が現行版のみのため常に false。 */
  isFuture: boolean;
  /** 改正予定＝この版より後の次版施行日（無ければ null）。既定モードでは解決しないため null。 */
  nextEnforceDate: string | null;
}

/**
 * 引用された参照（元番号付き）を返す。引用マーカーが無い場合は全参照へフォールバックする
 * （finalizeReport が従来おこなっていた選別を、構造化メタと共用するため純関数へ切り出したもの＝挙動不変）。
 */
export function resolveCitedReferences(
  reportText: string,
  searchResults: Reference[],
): IndexedReference[] {
  const filtered = filterReferencesByCitations(reportText, searchResults);
  if (filtered.length > 0) {
    return filtered;
  }
  return searchResults.map((r, i) => [i + 1, r] as IndexedReference);
}

/**
 * 引用参照から UI バッジ用の版メタ配列を作る（as-of 対応）。
 * as_of 指定時は resolveVersionsAsOf が付けた版メタをそのまま使う。既定モード（as_of 未指定）は
 * 版メタを持たないので、施行日だけ law_id から導出する（追加クエリなし・索引は現行版のみ＝isFuture false）。
 */
export function buildReferenceMetas(references: IndexedReference[]): LawRagReferenceMeta[] {
  return references.map(([n, r]) => ({
    n,
    title: r.title,
    url: r.url,
    enforceDate: r.enforceDate === undefined ? enforceDateFromLawId(r.lawId) : r.enforceDate,
    isFuture: r.isFuture ?? false,
    nextEnforceDate: r.nextEnforceDate ?? null,
  }));
}

// ---- 最終化 ----------------------------------------------------------------------------

/**
 * 引用リンク化・Mermaid 安全化・「## 出典」結合を行い最終レポートを返す（移植元 _finalize_report）。
 * dataAsOfLine（データ基準日）を渡すと出典節の先頭へ 1 行焼き込む（as-of 対応・知識時点の明示）。
 * 未指定なら as-of 導入前と同一の出典節（後方互換）。
 */
export function finalizeReport(
  reportText: string,
  searchResults: Reference[],
  dataAsOfLine?: string,
): string {
  const filtered = resolveCitedReferences(reportText, searchResults);
  const filteredText = filtered
    .map(([originalIdx, ref]) => formatReference(originalIdx - 1, ref))
    .join('\n\n');

  const withLinks = convertCitationToExternalLink(reportText, filtered);
  const sanitized = sanitizeMermaidContent(withLinks);
  const sourceBody = dataAsOfLine ? `${dataAsOfLine}\n\n${filteredText}` : filteredText;
  return [sanitized, '## 出典', sourceBody].join('\n\n');
}

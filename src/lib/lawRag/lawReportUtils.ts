import {
  egovUrl,
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

/** 出典節用の 1 参照フォーマット（番号は i+1・移植元 _format_reference の条文分岐）。 */
export function formatReference(i: number, r: Reference): string {
  const content = r.content ? normalizeContent(r.content) : '';
  const contentLine = content ? `\n　　> ${content}...` : '';
  return r.url
    ? `[${i + 1}] 🔗 **[${r.title}](${r.url})**${contentLine}`
    : `[${i + 1}] **${r.title}**${contentLine}`;
}

/** プロンプト向け 1 参照フォーマット（URL なし・全文・移植元 _format_reference_for_prompt の条文分岐）。 */
export function formatReferenceForPrompt(i: number, r: Reference): string {
  return `[${i + 1}] 【e-laws公式条文】 ${r.title}\n${r.content ?? ''}`;
}

// ---- 変換・マージ ----------------------------------------------------------------------

/** ArticleWithSummary を FullArticle に変換する（content を持つもののみ・移植元 _to_full_articles）。 */
export function toFullArticles(articles: ArticleWithSummary[]): FullArticle[] {
  const out: FullArticle[] = [];
  for (const a of articles) {
    if (a.content) {
      out.push({
        lawId: a.lawId,
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

// ---- 最終化 ----------------------------------------------------------------------------

/** 引用リンク化・Mermaid 安全化・「## 出典」結合を行い最終レポートを返す（移植元 _finalize_report）。 */
export function finalizeReport(reportText: string, searchResults: Reference[]): string {
  let filtered = filterReferencesByCitations(reportText, searchResults);
  // 引用マーカーが無い場合は全参照をフォールバック（元番号付き）。
  if (filtered.length === 0) {
    filtered = searchResults.map((r, i) => [i + 1, r] as IndexedReference);
  }
  const filteredText = filtered
    .map(([originalIdx, ref]) => formatReference(originalIdx - 1, ref))
    .join('\n\n');

  const withLinks = convertCitationToExternalLink(reportText, filtered);
  const sanitized = sanitizeMermaidContent(withLinks);
  return [sanitized, '## 出典', filteredText].join('\n\n');
}

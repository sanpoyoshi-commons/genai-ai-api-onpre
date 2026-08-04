import type { ArticleWithSummary } from '../../repositories/lawRetriever.js';

/**
 * 法令レポートの警告／照合プレフィックス生成（移植元 law_report_pipeline の
 * _bigram_similarity / _check_law_name_divergence / _build_substitution_warning /
 * _build_mentioned_articles_prefix の on-prem 移植）。
 *
 * いずれもクエリ・推定法令名・取得条文を突き合わせ、架空法令の誤マッピングや通称→正式名の読み替えを
 * 検出して「回答冒頭で開示せよ」という指示テキストを生成する純関数（ハルシネーション開示の核）。
 * 参考情報テキストの先頭に積んで LLM へ渡す。web grounding は無いが、ローカル LLM 知識推定でも
 * 同種の乖離（実在しない法令名→近傍の別法令にベクトル吸着）が起き得るため、そのまま移植する。
 */

/** クエリ中の「第N条」表記（移植元 _ARTICLE_NUM_PATTERN）。 */
export const ARTICLE_NUM_PATTERN = /第(\d+)条/g;

/**
 * as-of 参照時点の開示指示（as-of 対応）。as_of_date 指定時のみ参考情報の先頭へ積み、
 * 「どの版で答えたか」を回答冒頭で明示させる（信頼の核心＝時間軸の黙認防止）。
 */
export function buildAsOfNotice(asOfDate: string): string {
  return [
    '【参照時点の通知 - 回答の冒頭で必ず開示すること】',
    `本回答は ${asOfDate} 時点で施行されている版を基準に条文を参照しています。`,
    '未施行の条文には施行日を明示し、施行日が未定の場合はその旨を述べてください。',
    'いずれの版が適用されるかは附則の経過措置により条ごとに異なるため、最終判断は利用者に委ねてください。',
    '---',
    '',
  ].join('\n');
}

const PARTICLES = /[をにはがのもとでやへからまで等]/g;

/** バイグラム Jaccard 係数で 2 法令名の類似度を返す（助詞除去後・移植元 _bigram_similarity）。 */
export function bigramSimilarity(s1: string, s2: string): number {
  const a = (s1 ?? '').replace(PARTICLES, '');
  const b = (s2 ?? '').replace(PARTICLES, '');
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + 1 < s.length; i += 1) {
      out.add(s.slice(i, i + 2));
    }
    return out;
  };
  const b1 = bigrams(a);
  const b2 = bigrams(b);
  if (b1.size === 0 || b2.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const g of b1) {
    if (b2.has(g)) {
      inter += 1;
    }
  }
  const union = b1.size + b2.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bestSimilarity(name: string, candidates: string[]): { best: string; sim: number } {
  let best = candidates[0] ?? '';
  let sim = -1;
  for (const c of candidates) {
    const s = bigramSimilarity(name, c);
    if (s > sim) {
      sim = s;
      best = c;
    }
  }
  return { best, sim: sim < 0 ? 0 : sim };
}

/**
 * クエリ元法令名 vs 推定法令名を比較し、読み替え（類似度 < 0.30）があれば開示指示を返す
 * （移植元 _build_substitution_warning）。
 */
export function buildSubstitutionWarning(
  queryLawNames: string[],
  estimatedLawNames: string[],
): string {
  if (queryLawNames.length === 0 || estimatedLawNames.length === 0) {
    return '';
  }
  const threshold = 0.3;
  const substituted: Array<[string, string]> = [];
  for (const qname of queryLawNames) {
    const { best, sim } = bestSimilarity(qname, estimatedLawNames);
    if (sim < threshold) {
      substituted.push([qname, best]);
    }
  }
  if (substituted.length === 0) {
    return '';
  }
  const lines = ['【読み替え通知 - 回答の冒頭で必ず開示すること】'];
  for (const [original, replacement] of substituted) {
    lines.push(
      `ユーザーが指定した法令名「${original}」は実在しない可能性があります。` +
        `最も近い実在法令「${replacement}」として回答しますが、` +
        `「${original}」が通称・略称、または実在しない法令名である可能性を` +
        `回答の冒頭で明示してください。`,
    );
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * 推定法令名 vs 取得法令名（law_title）の乖離（類似度 < 0.40）を検出し警告を返す
 * （移植元 _check_law_name_divergence・架空法令の誤マッピング検出）。
 */
export function checkLawNameDivergence(
  lawNames: string[],
  articles: ArticleWithSummary[],
): string {
  if (lawNames.length === 0 || articles.length === 0) {
    return '';
  }
  const titles = [...new Set(articles.map((a) => a.lawTitle).filter((t) => t))];
  if (titles.length === 0) {
    return '';
  }
  const threshold = 0.4;
  const diverged: Array<[string, string, number]> = [];
  for (const name of lawNames) {
    const { best, sim } = bestSimilarity(name, titles);
    if (sim < threshold) {
      diverged.push([name, best, sim]);
    }
  }
  if (diverged.length === 0) {
    return '';
  }
  const lines = [
    '【警告】推定された法令名と取得された法令名に大きな乖離があります。',
    'クエリで指定・推定された法令が実在しないか、正式名称と大きく異なる可能性があります。',
    '',
  ];
  for (const [estimated, actual, sim] of diverged) {
    lines.push(`- 推定法令名 「${estimated}」 → 取得法令 「${actual}」（類似度: ${Math.round(sim * 100)}%）`);
  }
  lines.push(
    '',
    'この乖離がある場合、回答の冒頭で「指定された法令名が存在しない可能性」または' +
      '「通称・略称が正式名称に変換された」旨を明示してください。',
    '---',
    '',
  );
  return lines.join('\n');
}

/**
 * クエリで言及された条文番号に対応する条文のタイトルを参考情報の先頭に埋め込むプレフィックスを生成する
 * （移植元 _build_mentioned_articles_prefix・Approach A）。末尾一致で Article_20 への誤マッチを避ける。
 */
export function buildMentionedArticlesPrefix(
  query: string,
  articles: ArticleWithSummary[],
): string {
  const nums = [...(query ?? '').matchAll(ARTICLE_NUM_PATTERN)].map((m) => m[1]!);
  if (nums.length === 0) {
    return '';
  }
  const matched: Array<[string, ArticleWithSummary]> = [];
  for (const num of nums) {
    const pattern = new RegExp(`Article_${num}$`);
    const hit = articles.find((a) => pattern.test(a.uniqueAnchor));
    if (hit) {
      matched.push([num, hit]);
    }
  }
  if (matched.length === 0) {
    return '';
  }
  const lines = [
    '【クエリで指定された条文の照合情報 - 回答前に必ず確認すること】',
    'クエリに以下の条文番号が含まれています。この情報と照合した上で、前提が誤っている場合は冒頭で訂正してください。',
    '',
  ];
  for (const [num, article] of matched) {
    lines.push(`■ 第${num}条の正式タイトル: ${article.articleSummary ?? ''}`);
  }
  lines.push('', '---', '');
  return lines.join('\n');
}

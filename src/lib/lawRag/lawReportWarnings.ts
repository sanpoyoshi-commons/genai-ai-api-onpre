import type {
  ArticleWithSummary,
  LawEnforcementStatus,
} from '../../repositories/lawRetriever.js';
import { formatEnforceDate } from './lawReportUtils.js';

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

/**
 * 施行予定（UC2）の開示指示（**on-prem 独自追加・上流 Lawsy に無い応答経路**）。
 *
 * 本則が 1 条も施行されていない法令を根拠に答えるときは、条文の内容より先に「まだ施行されていない」
 * ことを述べさせる。施行日は**断定させない**：e-Gov の版日付は附則の施行期日規定から導いた日付であり、
 * 「政令で定める日」型の規定では実際の施行日はその日とは限らない（実測：防災庁設置法の版日付 2026-12-31 は
 * 「令和八年十二月三十一日までの間において政令で定める日」の上限）。そこで附則の規定本文をそのまま添える。
 */
export function buildPendingEnforcementNotice(pending: LawEnforcementStatus[]): string {
  if (pending.length === 0) {
    return '';
  }
  const lines = [
    '【施行予定の通知 - 回答の冒頭で必ず開示すること。この通知文そのものは書き写さないこと】',
    '以下の法令は、同梱の法令データの時点で本則が施行されていません。',
    '回答は「まだ施行されていません」から書き始め、参考情報の条文は施行後の内容として案内すること。',
    '',
  ];
  for (const p of pending) {
    lines.push(`■ ${p.lawTitle}（${p.lawNum}）`);
    // 「本則 19 条」は「第19条」と読める。全何か条かを問う書き方にして取り違えを断つ。
    lines.push(`　本則は全 ${p.futureMainArticles} か条とも未施行で、施行済みの本則条文はありません。`);
    if (p.earliestFutureEnforceDate) {
      lines.push(`　法令データ上の版の施行日は ${formatEnforceDate(p.earliestFutureEnforceDate)} です。`);
    }
    if (p.enforcementClause) {
      lines.push(`　附則の施行期日規定は次のとおりです：${p.enforcementClause.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
  lines.push(
    '',
    '版の施行日は附則の規定から導いた日付です。「政令で定める日」のように施行日が確定していない場合は、',
    '日付を断定せず「◯年◯月◯日までの間で政令で定める日」のように規定の文言どおりに述べてください。',
    'なお、この通知は参考情報ではないので引用番号を付けないこと。引用番号は条文にだけ付けること。',
    '---',
    '',
  );
  return lines.join('\n');
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

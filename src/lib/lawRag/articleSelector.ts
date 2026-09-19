import type { ArticleWithSummary } from '../../repositories/lawRetriever.js';
import type { LlmClient } from '../llm/llmClient.js';

/**
 * 条文選別（移植元 law_report_pipeline._select_articles / _parse_ai_selection の on-prem 移植）。
 *
 * 移植元は、法令名ベース検索で取得した条文群（法令まるごと）が多い場合に、条文概要リストを LLM へ渡し
 * 「クエリに引用すべき番号」を返させて関連条文だけに絞る（本文ベクトル検索の代わりに LLM 選別が
 * 関連性判定を担う＝移植元アーキの核）。本文 embedding/reranker は使わない。
 *
 * 上流との差分（gemma 向け適応・明示）:
 *   - prompt（PROMPT_SELECT_RELEVANT_ARTICLES）は Gemini 前提の一文をやめ、gemma 向けに
 *     「番号のみカンマ区切りで出力・説明やマークダウン禁止」を明示する（出力契約を狭めて parse 失敗を減らす）。
 *   - 移植元 _parse_ai_selection は「行頭が数字の行を split('.') で 1 番号」前提だが、上記 prompt が
 *     カンマ区切りを指示するため整合せず壊れる。on-prem 版は箇条書き記号・カンマ/読点・行区切りの揺れを
 *     吸収しつつ、空時フォールバック（≤3 件は全件／それ以上は先頭・中間・末尾）と重複排除＋上限 20 は移植元と同戦略。
 *   - 移植元の選別閾値「5 件超のみ選別」と「選別結果が空なら全件」も踏襲。
 */

/** gemma 向け条文選別システムプロンプト（移植元 PROMPT_SELECT_RELEVANT_ARTICLES の gemma 適応）。 */
export const SELECT_ARTICLES_SYSTEM_PROMPT = `あなたは日本の法令に精通したアシスタントです。条文概要リストの中から、ユーザーのクエリに回答する根拠として引用すべき条文を選んでください。

選び方:
- クエリに直接関係する条文だけを選ぶ。関係の薄い条文は選ばない。
- 最大 20 件まで。関連が無ければ少なくてよい。
- クエリに答える根拠になる条文が1つも無ければ、何も選ばずに空行だけを出力する（無理に選ばない）。

出力形式（厳守）:
- 選んだ条文の「番号」だけを、半角カンマ区切りで 1 行に出力する（例: 1, 4, 7）。
- 説明文・前置き・マークダウン・条文名・思考過程は一切出力しない。番号のみ。`;

/** 5 件以下なら選別せず全件使う閾値（移植元 _select_articles と同値）。 */
export const SELECT_THRESHOLD = 5;

/** 選別の上限件数（移植元 _parse_ai_selection の [:20] と同値）。 */
export const MAX_SELECTED = 20;

/**
 * 選別不成立（gemma が「番号のみ」契約を守らず散文を返した等）時に採る上位件数（on-prem 追加・タスク3 次層）。
 * 呼び出し側の候補は content_embedding 近傍ランク順（事前ランク）なので、上位 N 条＝最も関連する条になる。
 * 実測で正解条は事前ランク上位（≤7 位）に来るため、取りこぼさない深さに設定する。
 */
export const SELECT_FALLBACK_TOP_N = 10;

/**
 * content-rank floor（on-prem 追加・タスク3 次層）。候補が content 近傍ランク順である前提で、上位この件数は
 * **常に**最終選別へ含める。gemma の選別は run ごとに散文／単一番号／浅い top-3 とバラつき、ランク 4〜7 の
 * 正解条を能動的に落とす（実測）。LLM 選別を破壊的フィルタでなく加点的リファイナにし、content 上位の取りこぼしを
 * 構造的に防ぐ。正解条は安定して ≤7 位に来るため 8 とする（生成 context は実測 12k 字でも動作する範囲）。
 */
export const SELECT_FLOOR_TOP_N = 8;

// ---- 純関数（LLM 不要・ユニットテスト対象） ----------------------------------------------

/** 条文概要リストを 1 起点の番号付きテキストにする（移植元 summary_list_str と同形式）。 */
export function buildArticleSummaryList(articles: ArticleWithSummary[]): string {
  return articles
    .map((a, i) => `${i + 1}. ${a.lawTitle} - ${a.articleSummary ? a.articleSummary : '概要なし'}`)
    .join('\n');
}

/**
 * LLM 応答から選択インデックス（1 起点）を解析する（移植元 _parse_ai_selection の on-prem 移植）。
 * 箇条書き記号・カンマ/読点・改行の揺れを吸収。空なら移植元と同じフォールバック戦略を返す。
 */
export function parseAiSelection(selectionStr: string, maxIndex: number): number[] {
  const selected: number[] = [];
  for (const rawLine of (selectionStr ?? '').trim().split('\n')) {
    // 行頭の箇条書き記号・空白を除去（gemma の "- 3" "* 3" 等の揺れを吸収）。
    const cleaned = rawLine.trim().replace(/^[\s*\-・]+/, '');
    if (cleaned.length === 0) {
      continue;
    }
    // カンマ/読点区切りの複数番号に対応（prompt はカンマ区切りを指示）。
    for (const tok of cleaned.split(/[,、]/)) {
      const t = tok.trim();
      // **純粋な番号トークンのみ採用**する（末尾ピリオド許容）。"8. 民法" や "1. 労働者の権利…" のような
      // 番号＋テキストは契約違反（条文名・散文）として弾く。gemma が選別でなく散文の箇条書き要約を返したとき、
      // そのテーマ番号(1.2.3.)を条文 index と誤読して先頭条を誤選択する不具合（タスク3 次層）を断つ。
      if (!/^\d+\.?$/.test(t)) {
        continue;
      }
      const idx = Number.parseInt(t, 10);
      if (idx >= 1 && idx <= maxIndex) {
        selected.push(idx);
      }
    }
  }

  // フォールバック：候補は content ランク順（事前ランク）なので上位 N 条を採る。
  // 旧戦略 [先頭,中間,末尾] は未ランク前提で、ランク済み候補では正解条（実測 4〜7 位）を取りこぼす。
  if (selected.length === 0) {
    return rangeInclusive(1, Math.min(maxIndex, SELECT_FALLBACK_TOP_N));
  }

  // 重複排除（出現順保持）＋上限 20。
  return dedupeNums(selected).slice(0, MAX_SELECTED);
}

function rangeInclusive(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) {
    out.push(i);
  }
  return out;
}

function dedupeNums(nums: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of nums) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ---- 選別器（LlmClient 注入） -----------------------------------------------------------

export class ArticleSelector {
  constructor(private readonly llm: LlmClient) {}

  /**
   * 関連条文を選別する（移植元 _select_articles）。5 件以下はそのまま全件。LLM 選別が空・例外時は全件。
   *
   * **前提**: articles は content 近傍ランク順（事前ランク済）。content-rank floor（SELECT_FLOOR_TOP_N）として
   * 上位条を常に含め、LLM 選別はそこに加点する（破壊的フィルタでなく加点的リファイナ）。gemma 選別が不安定でも
   * content 上位の正解条を構造的に取りこぼさない（タスク3 次層）。
   */
  async select(
    query: string,
    articles: ArticleWithSummary[],
    model: string,
    requestId: string,
  ): Promise<ArticleWithSummary[]> {
    if (articles.length <= SELECT_THRESHOLD) {
      return articles;
    }

    let raw: string;
    try {
      raw = await this.llm.generate({
        model,
        messages: [
          { role: 'system', content: SELECT_ARTICLES_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `元のクエリ: ${query}\n\n条文概要リスト:\n${buildArticleSummaryList(articles)}`,
          },
        ],
        requestId,
      });
    } catch {
      // LLM 失敗時は全件で続行（移植元と同じ・選別はあくまで絞り込み補助）。
      return articles;
    }

    const indices = parseAiSelection(raw, articles.length);
    // content-rank floor（上位 N 条）＋ LLM 選別 を出現順で結合（floor 優先）→ 重複排除＋上限。
    const floorN = Math.min(articles.length, SELECT_FLOOR_TOP_N);
    const merged = dedupeNums([...rangeInclusive(1, floorN), ...indices])
      .filter((i) => i >= 1 && i <= articles.length)
      .slice(0, MAX_SELECTED);
    return merged.map((i) => articles[i - 1]!);
  }
}

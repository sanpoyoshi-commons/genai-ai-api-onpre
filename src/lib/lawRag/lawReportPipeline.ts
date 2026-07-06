import type {
  ArticleWithSummary,
  FullArticle,
  LawRetrieverLike,
} from '../../repositories/lawRetriever.js';
import type { LawNameAliases, LawNameEstimator } from './lawNameEstimator.js';
import {
  applyLawNameAliases,
  expandLawNamesWithOrdinances,
  extractLawNamesFromQuery,
  resolveLawNameAliases,
} from './lawNameEstimator.js';
import type { ArticleSelector } from './articleSelector.js';
import type { ReportGenerator } from './reportGenerator.js';
import {
  buildReferences,
  finalizeReport,
  toFullArticles,
} from './lawReportUtils.js';
import {
  ARTICLE_NUM_PATTERN,
  buildMentionedArticlesPrefix,
  buildSubstitutionWarning,
  checkLawNameDivergence,
} from './lawReportWarnings.js';

/**
 * 法令レポート生成オーケストレータ（移植元 law_report_pipeline.generate_law_report の
 * on-prem 移植）。法令名ベース 4 段階を 1:1 再現する：
 *   ① クエリから元法令名抽出 → ② ローカル LLM 法令名推定 → ③ 施行令/規則補完 →
 *   ④ law_title_embedding 近傍で法令特定＋全条文取得 → ⑤ 名称乖離 bigram チェック →
 *   ⑥ LLM 関連条文選別 → ⑦ 言及/summary-only 条文の全文化 → ⑧ LLM レポート生成 → ⑨ 出典結合。
 *
 * 上流との差分（方針確定 2026-06-06・明示）:
 *   - 段2 は web grounding 無しのローカル LLM 知識のみ（LawNameEstimator）。
 *   - 段2 が完全に空のときは on-prem 追加フォールバック searchLawsByQuery（クエリ直 embed→law_title 近傍）で
 *     救済し、minScore 未満で 0 件なら移植元同様のエラー文を返す。
 *   - web_hits / クエリ内 URL fetch は全省略（参考情報＝e-laws 条文のみ）。並列実行（ThreadPoolExecutor）は
 *     不要になったため逐次化。
 */

/** 段2 空時フォールバックの近傍取得数。 */
export const FALLBACK_TOP_K = 5;

/** 段2 空時フォールバックの最小 cosine 類似度（未満は捨てる・調整点）。 */
export const FALLBACK_MIN_SCORE = 0.5;

/**
 * 選別へ渡す候補条文の事前ランク上限（on-prem 追加・タスク3）。特定済み法令内で content_embedding 近傍の
 * 上位 k 条に圧縮してから LLM 選別へ。移植元（Gemini 巨大 context）は法令全条を選別器へ渡せたが、ローカル
 * gemma は数百〜数千条で選別契約が破綻し先頭条へ誤選択する（実測）。k はクエリ近傍なので正解条が上位に入り、
 * 仮に選別が失敗しても劣化先が「最も近い条」になる。選別器の SELECT_THRESHOLD(5) を十分上回る値にする。
 */
export const PRERANK_TOP_K = 30;

/** 法令名を特定できなかったときのエラー文（移植元の空時エラー踏襲）。 */
export const ERR_NO_LAW =
  'クエリから関連する法令を特定できませんでした。より具体的な法令名（例：民法、刑法、労働基準法など）を含めてクエリを再構成してください。';

/** 検索しても条文が得られなかったときのエラー文（移植元踏襲）。 */
export const ERR_NO_ARTICLES =
  '申し訳ございませんが、該当する法令が見つかりませんでした。システムの問題が発生している可能性があります。';

/** 全文化後に条文が空のときのエラー文（移植元踏襲）。 */
export const ERR_NO_FULL_ARTICLES = '該当する条文が見つかりませんでした。';

/** オーケストレータ依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface LawReportDeps {
  estimator: LawNameEstimator;
  selector: ArticleSelector;
  generator: ReportGenerator;
  retriever: LawRetrieverLike;
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.filter((s) => s))];
}

export class LawReportPipeline {
  private readonly aliases: LawNameAliases;

  /**
   * aliases 未指定時は設定（LAW_RAG_ALIASES_FILE の JSON）→空辞書の順で**起動時に 1 度だけ**解決する
   * （反映は api 再起動で。リーンプロンプト LAW_RAG_REPORT_PROMPT_FILE と同じ流儀）。
   */
  constructor(
    private readonly deps: LawReportDeps,
    aliases: LawNameAliases = resolveLawNameAliases(),
  ) {
    this.aliases = aliases;
  }

  /** 言及条文（クエリの「第N条」）の全文を取得する（移植元 _fetch_mentioned_articles_full_content）。 */
  private async fetchMentionedFull(
    query: string,
    articles: ArticleWithSummary[],
  ): Promise<FullArticle[]> {
    const nums = [...(query ?? '').matchAll(ARTICLE_NUM_PATTERN)].map((m) => m[1]!);
    if (nums.length === 0) {
      return [];
    }
    const lawNums = dedupeStrings(articles.map((a) => a.lawNum));
    if (lawNums.length === 0) {
      return [];
    }
    const uniqueAnchors = nums.map((n) => `Main_Article_${n}`);
    try {
      return await this.deps.retriever.getFullArticles(lawNums, uniqueAnchors);
    } catch {
      return [];
    }
  }

  /** summary のみ条文（100k 制限）を全文化する（移植元 _fetch_summary_only_full_content）。 */
  private async fetchSummaryOnlyFull(articles: ArticleWithSummary[]): Promise<FullArticle[]> {
    const summaryOnly = articles.filter((a) => a.isSummaryOnly);
    if (summaryOnly.length === 0) {
      return [];
    }
    const lawNums = dedupeStrings(summaryOnly.map((a) => a.lawNum));
    const uniqueAnchors = summaryOnly.map((a) => a.uniqueAnchor);
    if (lawNums.length === 0 || uniqueAnchors.length === 0) {
      return [];
    }
    try {
      return await this.deps.retriever.getFullArticles(lawNums, uniqueAnchors);
    } catch {
      return [];
    }
  }

  /**
   * 法令名推定 → 法令特定 → 特定法令内の事前ランク top-K 条文（段2 空時はクエリ直近傍フォールバック）。
   *
   * 法令特定（law_num 解決）は移植元どおり法令名ベースのまま。選別器へ渡す前に、特定法令の内側で
   * content_embedding 近傍 top-K（PRERANK_TOP_K）へ圧縮する（タスク3＝gemma 選別を可能なタスク化）。
   * 戻り値: null=法令を特定できず（→ ERR_NO_LAW）、[]=特定したが条文 0（→ ERR_NO_ARTICLES）。
   */
  private async retrieveArticles(
    query: string,
    lawNames: string[],
  ): Promise<ArticleWithSummary[] | null> {
    let lawNums: string[];
    if (lawNames.length === 0) {
      // on-prem フォールバック：クエリ自体を embed して law_title 近傍検索で法令特定。
      const candidates = await this.deps.retriever.searchLawsByQuery(
        query,
        FALLBACK_TOP_K,
        FALLBACK_MIN_SCORE,
      );
      if (candidates.length === 0) {
        return null; // minScore 未満で救済不能 → 呼び出し側がエラー文。
      }
      lawNums = dedupeStrings(candidates.map((c) => c.lawNum));
    } else {
      // 通称→正式名称を解決してから施行令補完（通称のままだと最近傍が別法を誤マッチするため）。
      const searchLawNames = expandLawNamesWithOrdinances(applyLawNameAliases(lawNames, this.aliases));
      lawNums = await this.deps.retriever.resolveLawNums(searchLawNames);
      if (lawNums.length === 0) {
        // 広めの再検索（移植元 broader search）。
        lawNums = await this.deps.retriever.resolveLawNums([
          ...searchLawNames,
          '法律',
          '規則',
          '政令',
        ]);
      }
    }

    if (lawNums.length === 0) {
      return []; // 法令名は出たが特定不能 → ERR_NO_ARTICLES。
    }

    // 事前ランク：特定法令の内側でクエリ近傍 top-K に圧縮してから選別へ。
    return this.deps.retriever.searchArticlesByContentInLaws(query, lawNums, PRERANK_TOP_K);
  }

  /** 法令レポートを生成して返す（移植元 generate_law_report・エラー時はメッセージ文字列を返す）。 */
  async generateReport(query: string, model: string, requestId: string): Promise<string> {
    // ① クエリから元法令名抽出（読み替え検出用に web 前表記を保持）。
    const queryLawNames = extractLawNamesFromQuery(query);

    // ② ローカル LLM 法令名推定。
    const lawNames = await this.deps.estimator.estimate(query, model, requestId);

    // ③④ 施行令補完＋法令特定＋全条文取得（段2 空時はフォールバック）。
    const articles0 = await this.retrieveArticles(query, lawNames);
    if (articles0 === null) {
      return ERR_NO_LAW;
    }
    if (articles0.length === 0) {
      return ERR_NO_ARTICLES;
    }

    // ⑤ 読み替え・名称乖離の警告（回答冒頭での開示指示）。
    const substitutionWarning = buildSubstitutionWarning(queryLawNames, lawNames);
    const divergenceWarning = checkLawNameDivergence(lawNames, articles0);

    // ⑥ LLM 関連条文選別（5 件超のみ）。
    const articles = await this.deps.selector.select(query, articles0, model, requestId);

    // ⑦ 言及条文プレフィックス＋全文化（言及条文・summary-only）。
    const mentionedPrefix = buildMentionedArticlesPrefix(query, articles);

    let finalArticles = toFullArticles(articles);
    if (finalArticles.length === 0) {
      return ERR_NO_FULL_ARTICLES;
    }

    const mentionedFull = await this.fetchMentionedFull(query, articles);
    if (mentionedFull.length > 0) {
      const anchors = new Set(mentionedFull.map((a) => a.uniqueAnchor));
      finalArticles = [
        ...mentionedFull,
        ...finalArticles.filter((a) => !anchors.has(a.uniqueAnchor)),
      ];
    }

    const summaryFull = await this.fetchSummaryOnlyFull(articles);
    if (summaryFull.length > 0) {
      const map = new Map(summaryFull.map((a) => [a.uniqueAnchor, a]));
      finalArticles = finalArticles.map((a) => map.get(a.uniqueAnchor) ?? a);
    }

    // ⑧ 参考情報組み立て＋警告プレフィックス（優先度順）＋レポート生成。
    const { searchResults, referencesText } = buildReferences(finalArticles);
    let withWarnings = referencesText;
    if (mentionedPrefix) {
      withWarnings = mentionedPrefix + withWarnings;
    }
    if (divergenceWarning) {
      withWarnings = divergenceWarning + withWarnings;
    }
    if (substitutionWarning) {
      withWarnings = substitutionWarning + withWarnings;
    }

    const report = await this.deps.generator.generate(query, withWarnings, model, requestId);

    // ⑨ 引用リンク化・出典結合。
    return finalizeReport(report, searchResults);
  }
}

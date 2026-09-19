import {
  articleTitle,
  egovUrl,
  versionKey,
  type ArticleWithSummary,
  type FullArticle,
  type LawEnforcementStatus,
  type LawRagMeta,
  type LawRetrieverLike,
} from '../../repositories/lawRetriever.js';
import { logger } from '../logger.js';
import {
  LAW_INDEX_UNAVAILABLE,
  resolveLawMatch,
  type LawMatchStage,
  type RejectedLawCandidate,
} from './lawMatchResolver.js';
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
  buildReferenceMetas,
  buildReferences,
  finalizeReport,
  resolveCitedReferences,
  toFullArticles,
  type LawRagReferenceMeta,
} from './lawReportUtils.js';
import {
  ARTICLE_NUM_PATTERN,
  buildAsOfNotice,
  buildMentionedArticlesPrefix,
  buildPendingEnforcementNotice,
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
 *
 * 上流との差分（3 値応答・2026-09-19 追加・明示）:
 *   移植元は「回答」か「法令を特定できない」の 2 値しか持たず、法令特定は最近傍 1 件を無条件に採る
 *   （距離の絶対値を見ない）。本実装は段2 を lawMatchResolver の判定階層へ置き換え、応答を 3 値にする：
 *     【現行】    … 従来と同一の回答（後方互換）。
 *     【施行予定】… 本則が未施行の法令。施行日と附則の施行期日規定を添え「まだ施行されていない」と答える。
 *                   e-Gov 全版データを持つ本配布物だけが返せる応答で、**上流 Lawsy に対応経路は無い**。
 *     【該当なし】… 固有部分の一致する法令が無い。**条文を一切提示しない**（近い法令を推測で出さない）。
 *   法令名マスタが空の環境（データ未投入の開発 DB・ユニットテストの fake）では従来経路へフォールバックする。
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

/**
 * 【該当なし】の応答文（**on-prem 独自追加**）。固有部分の一致する法令が無いときに返す。
 * 近い名称の別法令を推測で提示しないことを明示する（設計 §3・§4-2 の安全側方針）。
 */
export const ERR_NO_MATCH =
  'お尋ねの内容に該当する法令・条文が、同梱の法令データの中に見当たりませんでした。' +
  '名称の近い別の法令を根拠として提示することは避けています。' +
  '法令名がお分かりの場合は、正式名称を含めて質問し直してください。';

/** 段2 の識別結果（3 値応答の分岐に使う）。 */
type LawIdentification =
  | { kind: 'current'; lawNums: string[]; stage?: LawMatchStage }
  | {
      kind: 'pending';
      lawNums: string[];
      pending: LawEnforcementStatus[];
      stage: LawMatchStage;
    }
  | { kind: 'none'; stage: LawMatchStage; rejected: RejectedLawCandidate[] }
  | { kind: 'unidentified' };

/** as_of_date の受理形式（YYYY-MM-DD）。 */
export const AS_OF_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** as_of 指定時、その時点で施行されている該当条文が無かったときのエラー文（as-of 対応）。 */
export const ERR_NO_VERSION_AT_ASOF =
  '指定された時点（as_of_date）に施行されている該当条文が見つかりませんでした。日付を変えて再度お試しください。';

/**
 * レポート生成の結果（as-of 対応）。`report` は従来どおりの markdown（引用リンク・「## 出典」結合済み）で、
 * それに UI バッジ用の構造化メタを添える。エラー時はメッセージを `report` に入れメタは付かない
 * （呼び出し側＝route は `report` を outputs へそのまま載せる＝後方互換）。
 */
export interface LawReportResult {
  /** 最終レポート markdown（またはエラーメッセージ）。 */
  report: string;
  /** 版解決に使った参照時点（as_of 指定時のみ）。 */
  asOfDate?: string;
  /** データ基準日メタ（law_rag_meta 未投入時は付かない）。 */
  dataAsOf?: LawRagMeta;
  /** 引用条文ごとの版メタ（エラー時は付かない）。 */
  references?: LawRagReferenceMeta[];
}

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
    includeFuture: boolean,
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
      return await this.deps.retriever.getFullArticles(lawNums, uniqueAnchors, includeFuture);
    } catch {
      return [];
    }
  }

  /** summary のみ条文（100k 制限）を全文化する（移植元 _fetch_summary_only_full_content）。 */
  private async fetchSummaryOnlyFull(
    articles: ArticleWithSummary[],
    includeFuture: boolean,
  ): Promise<FullArticle[]> {
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
      return await this.deps.retriever.getFullArticles(lawNums, uniqueAnchors, includeFuture);
    } catch {
      return [];
    }
  }

  /**
   * as_of_date 時点の版へ finalArticles を差し替える（二段構えの「版を決める」段）。索引で位置特定した
   * 条文キー（law_num, unique_anchor）ごとに dwh から as_of 時点の現行版を解決し、本文・law_id・URL を
   * 差し替え、施行日／未施行／改正予定のメタを付ける。as_of 時点に該当版が無い条文は落とす。
   */
  private async resolveAsOf(articles: FullArticle[], asOfDate: string): Promise<FullArticle[]> {
    const keys = articles
      .filter((a) => a.lawNum)
      .map((a) => ({ lawNum: a.lawNum!, uniqueAnchor: a.uniqueAnchor }));
    const resolved = await this.deps.retriever.resolveVersionsAsOf(keys, asOfDate);
    const out: FullArticle[] = [];
    for (const a of articles) {
      if (!a.lawNum) {
        // 解決キーを持たない参照（fake 等）はそのまま通す（保険）。
        out.push(a);
        continue;
      }
      const v = resolved.get(versionKey(a.lawNum, a.uniqueAnchor));
      if (!v) {
        continue; // as_of 時点で該当版なし → drop。
      }
      out.push({
        ...a,
        lawId: v.lawId,
        // 条見出しも解決した版のものへ組み直す。本文だけ差し替えると、出典行の見出し（索引＝現行版）と
        // 引用本文（as_of 版）が別の版になり「どの版で答えたか」の表示が食い違う。
        title: a.lawTitle ? articleTitle(a.lawTitle, v.articleSummary) : a.title,
        content: v.content ?? a.content,
        anchor: v.anchor ?? a.anchor,
        url: egovUrl(v.lawId, v.anchor),
        enforceDate: v.enforceDate,
        isFuture: v.isFuture,
        nextEnforceDate: v.nextEnforceDate,
      });
    }
    return out;
  }

  /** データ基準日の焼き込み 1 行を作る（law_rag_meta 未投入なら undefined＝焼き込みなし）。 */
  private buildDataAsOfLine(meta: LawRagMeta | null): string | undefined {
    if (!meta) {
      return undefined;
    }
    return `データ基準日: ${meta.egovFetchDate}時点のe-Gov法令データ（${meta.releaseTag}）`;
  }

  /**
   * 段2「法令特定」（3 値判定）。通称辞書→施行令補完まで従来どおり行い、判定は lawMatchResolver に委ねる。
   *
   * 法令名マスタが空（法令データ未投入の開発 DB・ユニットテストの fake）のときは従来経路へフォールバックし、
   * 既存挙動をそのまま通す（後方互換）。
   */
  private async identifyLaws(
    query: string,
    lawNames: string[],
    queryLawNames: string[],
  ): Promise<LawIdentification> {
    // 通称→正式名称を解決してから施行令補完（通称のままだと最近傍が別法を誤マッチするため）。
    const searchLawNames =
      lawNames.length > 0
        ? expandLawNamesWithOrdinances(applyLawNameAliases(lawNames, this.aliases))
        : [];
    // クエリ本文の名乗りも同じ辞書を通す（「景品表示法」→「不当景品類及び不当表示防止法」）。
    const spokenLawNames = applyLawNameAliases(queryLawNames, this.aliases);
    const match = await resolveLawMatch(
      this.deps.retriever,
      query,
      searchLawNames,
      spokenLawNames,
    );
    if (match === LAW_INDEX_UNAVAILABLE) {
      return this.identifyLawsLegacy(query, searchLawNames);
    }
    if (match.verdict === 'none') {
      return { kind: 'none', stage: match.stage, rejected: match.rejected };
    }
    if (match.verdict === 'pending') {
      return {
        kind: 'pending',
        stage: match.stage,
        lawNums: match.lawNums,
        pending: match.pending,
      };
    }
    return { kind: 'current', stage: match.stage, lawNums: match.lawNums };
  }

  /**
   * 従来経路（as-of 導入前と同一の法令特定）。法令名マスタを読めない環境だけが通る。
   * 最近傍 1 件を無条件に採るため「該当なし」は出せない＝この経路では 2 値のままである点に注意。
   */
  private async identifyLawsLegacy(
    query: string,
    searchLawNames: string[],
  ): Promise<LawIdentification> {
    let lawNums: string[];
    if (searchLawNames.length === 0) {
      // on-prem フォールバック：クエリ自体を embed して law_title 近傍検索で法令特定。
      const candidates = await this.deps.retriever.searchLawsByQuery(
        query,
        FALLBACK_TOP_K,
        FALLBACK_MIN_SCORE,
      );
      if (candidates.length === 0) {
        return { kind: 'unidentified' }; // minScore 未満で救済不能 → ERR_NO_LAW。
      }
      lawNums = dedupeStrings(candidates.map((c) => c.lawNum));
    } else {
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
    return { kind: 'current', lawNums };
  }

  /**
   * 特定法令の内側で、クエリ近傍 top-K 条文へ事前圧縮する（タスク3＝gemma 選別を可能なタスク化）。
   * includeFuture は as_of 指定時（版解決で時点解決する）と施行予定モード（未施行条文が答えそのもの）で true。
   */
  private async retrieveArticles(
    query: string,
    lawNums: string[],
    includeFuture: boolean,
  ): Promise<ArticleWithSummary[]> {
    if (lawNums.length === 0) {
      return [];
    }
    return this.deps.retriever.searchArticlesByContentInLaws(
      query,
      lawNums,
      PRERANK_TOP_K,
      includeFuture,
    );
  }

  /**
   * 法令レポートを生成して返す（移植元 generate_law_report・エラー時はメッセージ文字列を返す）。
   *
   * asOfDate（YYYY-MM-DD）を渡すと as-of モード：未施行条文も候補に含め、位置特定した
   * 条文を as_of 時点の版へ構造的に解決して本文差し替え＋施行日/未施行/改正予定メタを付す。未指定なら
   * 現行索引経路（as-of 導入前）を無改変で通す（後方互換）。いずれのモードでもデータ基準日を出典へ焼き込む。
   *
   * 戻り値はレポート markdown ＋ UI バッジ用の構造化メタ（引用条文ごとの版メタ・データ基準日・参照時点）。
   * エラー時はメッセージのみ（`report`）を返す。
   */
  async generateReport(
    query: string,
    model: string,
    requestId: string,
    asOfDate?: string,
  ): Promise<LawReportResult> {
    // as_of は YYYY-MM-DD のみ受理（不正・未指定は既定経路＝as-of なし）。
    const asOf = asOfDate && AS_OF_DATE_PATTERN.test(asOfDate) ? asOfDate : undefined;
    const asOfMode = asOf !== undefined;

    // ① クエリから元法令名抽出（読み替え検出用に web 前表記を保持）。
    const queryLawNames = extractLawNamesFromQuery(query);

    // ② ローカル LLM 法令名推定。
    const lawNames = await this.deps.estimator.estimate(query, model, requestId);

    // ③ 施行令補完＋法令特定（3 値判定）。
    const identification = await this.identifyLaws(query, lawNames, queryLawNames);
    if (identification.kind === 'unidentified') {
      return { report: ERR_NO_LAW };
    }
    if (identification.kind === 'none') {
      // 【該当なし】＝条文を一切出さない。将来の緩和判断のため棄却候補を残す（設計 §4-2）。
      logger.info(
        {
          requestId,
          stage: identification.stage,
          estimatedLawNames: lawNames,
          rejected: identification.rejected.map((r) => r.lawTitle),
        },
        '法令RAG: 固有部分の一致する法令が無いため条文を提示しません（該当なし）',
      );
      return { report: ERR_NO_MATCH };
    }
    const pendingMode = identification.kind === 'pending';
    if (pendingMode) {
      logger.info(
        {
          requestId,
          stage: identification.stage,
          laws: identification.pending.map((p) => ({
            lawTitle: p.lawTitle,
            futureMainArticles: p.futureMainArticles,
            earliestFutureEnforceDate: p.earliestFutureEnforceDate,
          })),
        },
        '法令RAG: 本則が未施行の法令として回答します（施行予定）',
      );
    }

    // ④ 特定法令の内側で事前ランク top-K。施行予定モードは未施行条文が答えそのものなので必ず含める。
    const includeFuture = asOfMode || pendingMode;
    const articles0 = await this.retrieveArticles(query, identification.lawNums, includeFuture);
    if (articles0.length === 0) {
      return { report: ERR_NO_ARTICLES };
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
      return { report: ERR_NO_FULL_ARTICLES };
    }

    const mentionedFull = await this.fetchMentionedFull(query, articles, includeFuture);
    if (mentionedFull.length > 0) {
      const anchors = new Set(mentionedFull.map((a) => a.uniqueAnchor));
      finalArticles = [
        ...mentionedFull,
        ...finalArticles.filter((a) => !anchors.has(a.uniqueAnchor)),
      ];
    }

    const summaryFull = await this.fetchSummaryOnlyFull(articles, includeFuture);
    if (summaryFull.length > 0) {
      const map = new Map(summaryFull.map((a) => [a.uniqueAnchor, a]));
      finalArticles = finalArticles.map((a) => map.get(a.uniqueAnchor) ?? a);
    }

    // ⑦-2 as-of 版解決（as_of 指定時のみ）：位置特定した条文を as_of 時点の版へ差し替え＋メタ付与。
    if (asOf) {
      finalArticles = await this.resolveAsOf(finalArticles, asOf);
      if (finalArticles.length === 0) {
        return { report: ERR_NO_VERSION_AT_ASOF };
      }
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
    // as-of モードは参照時点の開示指示を前置（「どの版で答えたか」を黙らせない）。
    if (asOf) {
      withWarnings = buildAsOfNotice(asOf) + withWarnings;
    }
    // 施行予定は最優先で前置する（条文の中身より先に「まだ施行されていない」を言わせる）。
    if (identification.kind === 'pending') {
      withWarnings = buildPendingEnforcementNotice(identification.pending) + withWarnings;
    }

    const report = await this.deps.generator.generate(query, withWarnings, model, requestId);

    // ⑨ 引用リンク化・出典結合＋データ基準日焼き込み（常時・law_rag_meta 未投入なら焼き込みなし）。
    const meta = await this.deps.retriever.getLawRagMeta();
    const finalReport = finalizeReport(report, searchResults, this.buildDataAsOfLine(meta));

    // ⑩ UI バッジ用の構造化メタ。焼き込み（markdown）と同じ引用参照から作るため両者は必ず一致する。
    const references = buildReferenceMetas(resolveCitedReferences(report, searchResults));
    return {
      report: finalReport,
      ...(asOf ? { asOfDate: asOf } : {}),
      ...(meta ? { dataAsOf: meta } : {}),
      references,
    };
  }
}

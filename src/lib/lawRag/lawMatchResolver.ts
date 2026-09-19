import type {
  LawEnforcementStatus,
  LawRetrieverLike,
  LawTitleEntry,
} from '../../repositories/lawRetriever.js';
import {
  MIN_IDENTIFIER_LENGTH,
  extractLawIdentifier,
  identifierAppearsInQuery,
  identifierKey,
  identifiersMatch,
  normalizeLawName,
} from './lawNameIdentifier.js';

/**
 * 段2「法令特定」の判定階層（**on-prem 独自追加・移植元 Lawsy に対応物なし**）。
 *
 * 上流との差分（明示）:
 *   移植元 `retrieval_bq.py get_articles_by_nearest_law` は法令名 embedding の**最近傍 1 件を無条件に採る**。
 *   距離の絶対値を見る箇所がどこにも無いため、コーパスに該当法令が無いクエリでも必ず別法令が返る
 *   （実測：「防災庁はもう設置されていますか」→ 復興庁設置法の条文で回答）。上流はこの穴を
 *   Gemini＋Google 検索 grounding が塞いでいたが、on-prem に web は無い。
 *
 *   代わりに**手元の法令名マスタを辞書として引く**。一致の強さで階層化し、最下層（あいまい一致）では
 *   固有部分（lawNameIdentifier）の一致を**必須条件**に置いて、通らない候補は条文を出さずに
 *   「該当なし」を返す。閾値では切れないことは実測済み
 *   （bigm_similarity('防災庁設置法','復興庁設置法')=0.5714 > 既定 similarity_limit 0.3）。
 *
 *   さらに上流に無い応答として【施行予定】を持つ。e-Gov 全版データを保持する本配布物は
 *   「まだ施行されていない」と答えられる（UC2）。
 *
 * ```
 * 段2-0  正規化完全一致（法令名マスタ）              ⇒ 施行状態で【現行】/【施行予定】
 * 段2-1  ＝2-0 のヒットを本則条文の施行状態で分類     ⇒【施行予定】は本則が 1 条も施行されていない法令
 * 段2-2  固有部分の比較キーが完全一致                 ⇒ 同上（通称→正式名称の距離を吸収）
 * 段2-3  pg_bigm ＋ ベクトルの RRF 候補
 *          固有部分が一致する候補のみ採用             ⇒ 全滅なら【該当なし】
 * ```
 */

/** 3 値応答の判定（設計 §3）。 */
export type LawMatchVerdict = 'current' | 'pending' | 'none';

/**
 * 判定が確定した段（ログ・eval 用）。
 * `2-Q` は「利用者がクエリで名乗った法令が手元に無い」＝推定器の言い分を見るまでもなく【該当なし】。
 */
export type LawMatchStage = '2-Q' | '2-0' | '2-2' | '2-3';

/** 固有部分の不一致で棄却した候補（将来の緩和判断に備えてログへ残す・設計 §4-2）。 */
export interface RejectedLawCandidate {
  lawNum: string;
  lawTitle: string;
  score: number;
}

export interface LawMatchResult {
  verdict: LawMatchVerdict;
  stage: LawMatchStage;
  /** 【現行】のとき回答に使う法令。 */
  lawNums: string[];
  /** 【施行予定】のときの対象法令と施行情報。 */
  pending: LawEnforcementStatus[];
  /** 固有部分の不一致で棄却した候補。 */
  rejected: RejectedLawCandidate[];
}

/** 段2-3 のハイブリッド候補取得数（固有部分ゲートで絞るため広めに取る）。 */
export const LAW_TITLE_CANDIDATE_TOP_K = 5;

/** 法令名マスタが空（法令データ未投入）のとき返す番兵。呼び出し側は従来経路へフォールバックする。 */
export const LAW_INDEX_UNAVAILABLE = null;

function toRejected(c: { lawNum: string; lawTitle: string; score: number }): RejectedLawCandidate {
  return { lawNum: c.lawNum, lawTitle: c.lawTitle, score: c.score };
}

/**
 * 本則条文の施行状態から法令を【現行】/【施行予定】へ振り分ける。
 *
 * 判定粒度を**本則条文**に置くのが要点。e-Gov 一括データでは未施行の新法でも附則第一条（施行期日）は
 * 公布日施行で現行版になるため、「現行索引に在るか」では新法を現行と誤判定する（実測：防災庁設置法は
 * 現行条文 2 件＝附則のみ・本則 19 条は未施行）。本則が 1 条も施行されていない法令だけを施行予定とする。
 * 本則を持たない法令（廃止政令等・実測 42 件）は未施行ではないので現行に入れる。
 */
export function classifyEnforcement(statuses: LawEnforcementStatus[]): {
  current: LawEnforcementStatus[];
  pending: LawEnforcementStatus[];
} {
  const current: LawEnforcementStatus[] = [];
  const pending: LawEnforcementStatus[] = [];
  for (const s of statuses) {
    if (s.currentMainArticles > 0 || s.futureMainArticles === 0) {
      current.push(s);
    } else {
      pending.push(s);
    }
  }
  return { current, pending };
}

/** 段2-0：法令名マスタに対する正規化完全一致。 */
export function matchExactTitles(index: LawTitleEntry[], lawNames: string[]): LawTitleEntry[] {
  const wanted = new Set(lawNames.map((n) => normalizeLawName(n)).filter((n) => n.length > 0));
  if (wanted.size === 0) {
    return [];
  }
  return index.filter((e) => wanted.has(e.normalized));
}

/**
 * 段2-2：固有部分の比較キーが完全一致する法令。
 *
 * 設計 §4-2 は段2-2 を「前方一致・包含」と定義し、安全側方針により【該当なし】へ畳むとしていた。
 * 本実装は**包含を採らず比較キーの完全一致に限定**したうえで、ヒットを採用する（畳まない）。理由は
 * 実測 2 点：(1) 包含は `identifiersMatch('会社法','会社更生法')` を通してしまい安全側に反する。
 * (2) 完全一致に限れば、法令名マスタ 7,826 件の走査で**別主題どうしの識別子衝突は 0 件**
 * （同一キーの群 1,391 はすべて「◯◯法／◯◯法施行令／◯◯法施行規則」型の同一主題）。
 * 畳むべき曖昧性が無いため、畳むと recall だけを失う。
 */
export function matchByIdentifier(index: LawTitleEntry[], lawNames: string[]): LawTitleEntry[] {
  const keys = new Set(
    lawNames
      .map((n) => identifierKey(extractLawIdentifier(n)))
      .filter((k) => k.length >= MIN_IDENTIFIER_LENGTH),
  );
  if (keys.size === 0) {
    return [];
  }
  return index.filter((e) => keys.has(e.identifier));
}

/**
 * 段2 の判定を行う。法令名マスタが空（データ未投入）のときは null を返し、呼び出し側は従来経路へ落ちる。
 *
 * @param lawNames      段1 で推定した法令名（通称辞書・施行令補完を適用済み）。空なら段1 が沈黙した経路。
 * @param queryLawNames 利用者が**クエリ本文で名乗った**法令名（同じく辞書適用済み）。段2-Q に使う。
 */
export async function resolveLawMatch(
  retriever: LawRetrieverLike,
  query: string,
  lawNames: string[],
  queryLawNames: string[] = [],
): Promise<LawMatchResult | typeof LAW_INDEX_UNAVAILABLE> {
  const index = await retriever.getLawTitleIndex();
  if (index.length === 0) {
    return LAW_INDEX_UNAVAILABLE;
  }

  // 段2-Q：利用者が名乗った法令が手元に 1 つも無いなら、そこで【該当なし】。
  //
  // 固有部分ゲートは「推定器が挙げた名前」を検査するので、**推定器が実在の別法令を挙げたとき**は
  // 素通りしてしまう（実測：「人工知能人格権法の適用範囲は」→ 推定 [民法 / 個人情報の保護に関する法律 /
  // 著作権法] → 民法の条文で回答）。利用者が名指しした法令こそが問いの主語なので、それが手元に無いなら
  // 推定器が何を挙げていても条文は出さない。名乗りが無いクエリ（大半の内容質問）はこの段を素通りする。
  if (queryLawNames.length > 0) {
    const named = [
      ...matchExactTitles(index, queryLawNames),
      ...matchByIdentifier(index, queryLawNames),
    ];
    if (named.length === 0) {
      return { verdict: 'none', stage: '2-Q', lawNums: [], pending: [], rejected: [] };
    }
  }

  let stage: LawMatchStage = '2-0';
  let hits = matchExactTitles(index, lawNames);
  const rejected: RejectedLawCandidate[] = [];

  if (hits.length === 0 && lawNames.length > 0) {
    stage = '2-2';
    hits = matchByIdentifier(index, lawNames);
  }

  if (hits.length === 0) {
    stage = '2-3';
    const candidates = await retriever.searchLawTitlesHybrid(query, LAW_TITLE_CANDIDATE_TOP_K);
    // ゲート＝固有部分の一致。段1 が法令名を出していればその名と、沈黙していればクエリ本文と突き合わせる。
    const accepts = (title: string): boolean =>
      lawNames.length > 0
        ? lawNames.some((n) => identifiersMatch(n, title))
        : identifierAppearsInQuery(title, query);
    const accepted: LawTitleEntry[] = [];
    for (const c of candidates) {
      if (accepts(c.lawTitle)) {
        accepted.push({
          lawNum: c.lawNum,
          lawTitle: c.lawTitle,
          normalized: normalizeLawName(c.lawTitle),
          identifier: identifierKey(extractLawIdentifier(c.lawTitle)),
        });
      } else {
        rejected.push(toRejected(c));
      }
    }
    hits = accepted;
  }

  if (hits.length === 0) {
    return { verdict: 'none', stage, lawNums: [], pending: [], rejected };
  }

  const statuses = await retriever.getLawEnforcementStatus(hits.map((h) => h.lawNum));
  const { current, pending } = classifyEnforcement(statuses);
  if (current.length > 0) {
    // 現行の法令が 1 つでもあればそれで答える（施行予定の関連法令が混ざっていても現行を優先）。
    return {
      verdict: 'current',
      stage,
      lawNums: current.map((s) => s.lawNum),
      pending: [],
      rejected,
    };
  }
  return {
    verdict: 'pending',
    stage,
    lawNums: pending.map((s) => s.lawNum),
    pending,
    rejected,
  };
}

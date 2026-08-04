import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ArticleKey,
  ArticleWithSummary,
  FullArticle,
  LawCandidate,
  LawRagMeta,
  LawRetrieverLike,
  ResolvedVersion,
} from '../../../src/repositories/lawRetriever.js';
import { versionKey } from '../../../src/repositories/lawRetriever.js';
import type { LlmClient } from '../../../src/lib/llm/llmClient.js';
import { LawNameEstimator } from '../../../src/lib/lawRag/lawNameEstimator.js';
import { ArticleSelector } from '../../../src/lib/lawRag/articleSelector.js';
import { ReportGenerator } from '../../../src/lib/lawRag/reportGenerator.js';
import {
  ERR_NO_ARTICLES,
  ERR_NO_LAW,
  ERR_NO_VERSION_AT_ASOF,
  LawReportPipeline,
} from '../../../src/lib/lawRag/lawReportPipeline.js';

const fixedLlm = (text: string): LlmClient => ({
  async generate() {
    return text;
  },
  async *generateStream() {},
});

function makeArticle(over: Partial<ArticleWithSummary>): ArticleWithSummary {
  return {
    lawNum: 'n1',
    lawId: 'id1',
    lawTitle: '民法',
    uniqueAnchor: 'Main_Article_1',
    articleSummary: '概要',
    content: '本文',
    isSummaryOnly: false,
    ...over,
  };
}

/** 設定可能な fake retriever。 */
class FakeRetriever implements LawRetrieverLike {
  /** 事前ランク（searchArticlesByContentInLaws）が返す候補条文＝選別器へ渡る。 */
  byContent: ArticleWithSummary[] = [];
  /** resolveLawNums が返す law_num（[] で「特定不能」を表現）。 */
  lawNums: string[] = ['n1'];
  byNearest: ArticleWithSummary[] = [];
  byLawNums: ArticleWithSummary[] = [];
  candidates: LawCandidate[] = [];
  full: FullArticle[] = [];
  resolveCalls: string[][] = [];
  contentCalls: Array<{ query: string; lawNums: string[]; k: number; includeFuture: boolean }> = [];
  /** as-of：版解決マップ（キー＝versionKey(lawNum,uniqueAnchor)）。既定は空＝全 drop。 */
  versions = new Map<string, ResolvedVersion>();
  /** as-of：resolveVersionsAsOf の呼び出し記録（未呼び出し＝後方互換の担保に使う）。 */
  resolveAsOfCalls: Array<{ keys: ArticleKey[]; asOfDate: string }> = [];
  /** as-of：law_rag_meta（null＝未投入＝焼き込みなし）。 */
  meta: LawRagMeta | null = null;

  async resolveLawNums(lawNames: string[]): Promise<string[]> {
    this.resolveCalls.push(lawNames);
    return this.lawNums;
  }
  async searchArticlesByContentInLaws(
    query: string,
    lawNums: string[],
    k: number,
    includeFuture = false,
  ): Promise<ArticleWithSummary[]> {
    this.contentCalls.push({ query, lawNums, k, includeFuture });
    return this.byContent;
  }
  async getArticlesByNearestLaw(): Promise<ArticleWithSummary[]> {
    return this.byNearest;
  }
  async searchLawsByQuery(): Promise<LawCandidate[]> {
    return this.candidates;
  }
  async getArticlesByLawNums(): Promise<ArticleWithSummary[]> {
    return this.byLawNums;
  }
  async getFullArticles(): Promise<FullArticle[]> {
    return this.full;
  }
  async resolveVersionsAsOf(
    keys: ArticleKey[],
    asOfDate: string,
  ): Promise<Map<string, ResolvedVersion>> {
    this.resolveAsOfCalls.push({ keys, asOfDate });
    return this.versions;
  }
  async getLawRagMeta(): Promise<LawRagMeta | null> {
    return this.meta;
  }
}

function makePipeline(retriever: LawRetrieverLike, estimateJson: string, report: string) {
  return new LawReportPipeline({
    estimator: new LawNameEstimator(fixedLlm(estimateJson)),
    selector: new ArticleSelector(fixedLlm('1')),
    generator: new ReportGenerator(fixedLlm(report)),
    retriever,
  });
}

test('happy path: estimate → resolve → prerank → select(all) → report → finalize with 出典', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [
    makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_709', content: '不法行為本文' }),
    makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_710', content: '損害賠償本文' }),
  ];
  const pipeline = makePipeline(
    retriever,
    '{"law_names":["民法"]}',
    '# 不法行為責任\n民法は不法行為責任を定めます [1]。',
  );
  const { report: out } = await pipeline.generateReport('不法行為とは？', 'gemma', 'r');
  assert.ok(out.startsWith('# 不法行為責任'));
  assert.ok(out.includes('## 出典'));
  assert.ok(out.includes('[[1]](https://laws.e-gov.go.jp/law/id1)'));
  // 施行令補完が resolveLawNums に渡る（民法 → 民法施行令/施行規則）。
  assert.ok(retriever.resolveCalls[0]?.includes('民法施行令'));
  // 事前ランクは特定法令内・PRERANK_TOP_K=30・クエリ付きで呼ばれる。
  assert.equal(retriever.contentCalls.length, 1);
  assert.deepEqual(retriever.contentCalls[0]?.lawNums, ['n1']);
  assert.equal(retriever.contentCalls[0]?.k, 30);
  assert.equal(retriever.contentCalls[0]?.query, '不法行為とは？');
});

test('empty estimate → fallback searchLawsByQuery rescues via prerank', async () => {
  const retriever = new FakeRetriever();
  retriever.candidates = [{ lawNum: 'n1', lawTitle: '民法', score: 0.8 }];
  retriever.byContent = [makeArticle({ content: '本文' })];
  const pipeline = makePipeline(retriever, '{"law_names":[]}', '# T\n本文 [1]。');
  const { report: out } = await pipeline.generateReport('お金を貸したのに返ってこない', 'gemma', 'r');
  assert.ok(out.includes('## 出典'));
  assert.equal(retriever.resolveCalls.length, 0); // resolve は呼ばれない（フォールバック経路）。
  // 事前ランクは候補法令の law_num で呼ばれる。
  assert.deepEqual(retriever.contentCalls[0]?.lawNums, ['n1']);
});

test('empty estimate + empty fallback → ERR_NO_LAW', async () => {
  const retriever = new FakeRetriever();
  retriever.candidates = [];
  const pipeline = makePipeline(retriever, '{"law_names":[]}', 'unused');
  const { report: out } = await pipeline.generateReport('意味不明クエリ', 'gemma', 'r');
  assert.equal(out, ERR_NO_LAW);
});

test('estimate ok but law unresolved (resolve + broader empty) → ERR_NO_ARTICLES', async () => {
  const retriever = new FakeRetriever();
  retriever.lawNums = []; // 法令特定できない。
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', 'unused');
  const { report: out } = await pipeline.generateReport('民法について', 'gemma', 'r');
  assert.equal(out, ERR_NO_ARTICLES);
  // broader 再検索も試みる（2 回 resolve が呼ばれる）。
  assert.equal(retriever.resolveCalls.length, 2);
  // 特定不能なので事前ランクは呼ばれない。
  assert.equal(retriever.contentCalls.length, 0);
});

test('law resolved but prerank returns no articles → ERR_NO_ARTICLES', async () => {
  const retriever = new FakeRetriever();
  retriever.lawNums = ['n1'];
  retriever.byContent = []; // 法令は特定したが近傍 0 件。
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', 'unused');
  const { report: out } = await pipeline.generateReport('民法について', 'gemma', 'r');
  assert.equal(out, ERR_NO_ARTICLES);
  assert.equal(retriever.contentCalls.length, 1); // 事前ランクは呼ばれる。
});

test('summary-only article upgraded to full content via getFullArticles', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [
    makeArticle({ uniqueAnchor: 'Main_Article_1', content: '要約のみ', isSummaryOnly: true }),
  ];
  retriever.full = [
    {
      lawId: 'id1',
      title: '民法',
      content: '全文に差し替え済み',
      uniqueAnchor: 'Main_Article_1',
      anchor: null,
      url: 'https://laws.e-gov.go.jp/law/id1',
    },
  ];
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', '# T\n参照 [1]。');
  const { report: out } = await pipeline.generateReport('民法の概要', 'gemma', 'r');
  assert.ok(out.includes('全文に差し替え済み'));
});

// ── as-of 回帰テスト ──────────────────────────────────────────────

/** レポート生成の LLM 入力（user メッセージ）を捕捉する fake（参照時点通知の前置き確認用）。 */
function capturingGenerator(text: string): { gen: ReportGenerator; lastUser: () => string } {
  let last = '';
  const llm: LlmClient = {
    async generate(req: { messages: Array<{ content: string }> }) {
      last = req.messages.map((m) => m.content).join('\n');
      return text;
    },
    async *generateStream() {},
  };
  return { gen: new ReportGenerator(llm), lastUser: () => last };
}

test('後方互換: as_of 未指定なら版解決 seam を呼ばず includeFuture=false（既定経路）', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_1', content: '現行本文' })];
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', '# T\n本文 [1]。');
  const { report: out } = await pipeline.generateReport('民法とは', 'gemma', 'r');
  // 版解決は一度も呼ばれない（後方互換の核心）。
  assert.equal(retriever.resolveAsOfCalls.length, 0);
  // 索引検索は現行版のみ（未施行を含めない）。
  assert.equal(retriever.contentCalls[0]?.includeFuture, false);
  // meta 未投入なのでデータ基準日行は焼き込まれない（＝as-of 導入前と同一）。
  assert.ok(!out.includes('データ基準日'));
});

test('データ基準日: law_rag_meta があれば出典節へ 1 行焼き込む（既定モードでも常時）', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_1', content: '本文' })];
  retriever.meta = { egovFetchDate: '2026-08-01', releaseTag: 'law-rag-20260802' };
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', '# T\n本文 [1]。');
  const { report: out } = await pipeline.generateReport('民法とは', 'gemma', 'r');
  assert.ok(out.includes('データ基準日: 2026-08-01時点のe-Gov法令データ（law-rag-20260802）'));
  // 焼き込み位置は出典節（## 出典 の後ろに現れる）。
  assert.ok(out.indexOf('## 出典') < out.indexOf('データ基準日'));
});

test('Case A（未来日指定）: 未施行本則が版解決でヒットし本文差替＋施行日/未施行メタが付く', async () => {
  const retriever = new FakeRetriever();
  // 索引は現行版（附則等）で位置特定するが、as_of で本則の将来版へ解決する想定。
  retriever.byContent = [
    makeArticle({ lawNum: 'bosai', uniqueAnchor: 'Main_Article_2', content: '索引側本文' }),
  ];
  retriever.versions.set(versionKey('bosai', 'Main_Article_2'), {
    lawId: 'ID9_20280401_x',
    content: '防災庁は次に掲げる事務をつかさどる（未施行本則）',
    articleSummary: null,
    anchor: null,
    enforceDate: '2028-04-01',
    isFuture: true,
    nextEnforceDate: null,
  });
  retriever.meta = { egovFetchDate: '2026-08-01', releaseTag: 'law-rag-20260802' };
  const { gen, lastUser } = capturingGenerator('# 防災庁\n所掌事務は次のとおり [1]。');
  const pipeline = new LawReportPipeline({
    estimator: new LawNameEstimator(fixedLlm('{"law_names":["防災庁設置法"]}')),
    selector: new ArticleSelector(fixedLlm('1')),
    generator: gen,
    retriever,
  });
  const { report: out } = await pipeline.generateReport('防災庁の所掌事務は？', 'gemma', 'r', '2030-01-01');
  // 未施行を候補に含め、版解決が as_of 日付で呼ばれる。
  assert.equal(retriever.contentCalls[0]?.includeFuture, true);
  assert.equal(retriever.resolveAsOfCalls.length, 1);
  assert.equal(retriever.resolveAsOfCalls[0]?.asOfDate, '2030-01-01');
  // 本文が as_of 版へ差し替わり、出典に施行日＋未施行メタが付く。
  assert.ok(out.includes('未施行本則'));
  assert.ok(out.includes('施行日: 2028-04-01'));
  assert.ok(out.includes('未施行'));
  assert.ok(out.includes('データ基準日: 2026-08-01時点'));
  // 参照時点の開示指示が LLM 入力（参考情報）へ前置される。
  assert.ok(lastUser().includes('参照時点の通知'));
  assert.ok(lastUser().includes('2030-01-01'));
});

test('as_of 指定でその時点に該当版が無い → ERR_NO_VERSION_AT_ASOF', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_1', content: '本文' })];
  // versions マップは空＝as_of 時点で解決不能 → 全 drop。
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', '# T\n本文 [1]。');
  const { report: out } = await pipeline.generateReport('民法とは', 'gemma', 'r', '1900-01-01');
  assert.equal(out, ERR_NO_VERSION_AT_ASOF);
});

test('不正な as_of_date（YYYY-MM-DD でない）は無視して既定経路', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_1', content: '本文' })];
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', '# T\n本文 [1]。');
  await pipeline.generateReport('民法とは', 'gemma', 'r', 'not-a-date');
  assert.equal(retriever.resolveAsOfCalls.length, 0);
  assert.equal(retriever.contentCalls[0]?.includeFuture, false);
});

// ── 構造化メタ返却（UI バッジ用） ─────────────────────────────────

test('既定モード: references が付き、施行日は law_id から導出され isFuture=false', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [
    makeArticle({
      lawNum: 'n1',
      lawId: '129AC0000000089_20260723_508AC0000000053',
      uniqueAnchor: 'Main_Article_331_2',
      content: '現行本文',
    }),
  ];
  retriever.meta = { egovFetchDate: '2026-08-01', releaseTag: 'law-rag-20260802' };
  const pipeline = makePipeline(retriever, '{"law_names":["会社法"]}', '# T\n本文 [1]。');
  const res = await pipeline.generateReport('取締役の欠格事由は？', 'gemma', 'r');
  // 版解決 seam は呼ばれない（既定モードは無改変）が、UI バッジ用メタは返る。
  assert.equal(retriever.resolveAsOfCalls.length, 0);
  assert.equal(res.asOfDate, undefined);
  assert.deepEqual(res.dataAsOf, { egovFetchDate: '2026-08-01', releaseTag: 'law-rag-20260802' });
  assert.equal(res.references?.length, 1);
  const ref = res.references![0]!;
  assert.equal(ref.n, 1);
  assert.equal(ref.enforceDate, '2026-07-23'); // law_id 中間フィールド由来（追加クエリなし）。
  assert.equal(ref.isFuture, false);
  assert.equal(ref.nextEnforceDate, null);
  assert.ok(ref.url.startsWith('https://laws.e-gov.go.jp/law/129AC0000000089'));
});

test('as_of 指定: references に版解決メタ（施行日・未施行・改正予定）と asOfDate が載る', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [
    makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_331_2', content: '索引側本文' }),
  ];
  retriever.versions.set(versionKey('n1', 'Main_Article_331_2'), {
    lawId: 'ID_20281223_x',
    content: '特定補助人（未施行）',
    articleSummary: null,
    anchor: null,
    enforceDate: '2028-12-23',
    isFuture: true,
    nextEnforceDate: '2030-04-01',
  });
  const pipeline = makePipeline(retriever, '{"law_names":["会社法"]}', '# T\n本文 [1]。');
  const res = await pipeline.generateReport('取締役の欠格事由は？', 'gemma', 'r', '2029-01-01');
  assert.equal(res.asOfDate, '2029-01-01');
  const ref = res.references![0]!;
  assert.equal(ref.enforceDate, '2028-12-23');
  assert.equal(ref.isFuture, true);
  assert.equal(ref.nextEnforceDate, '2030-04-01');
});

test('引用番号が非連続でも references の n は元番号を保持する', async () => {
  const retriever = new FakeRetriever();
  retriever.byContent = [
    makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_1', content: '本文1' }),
    makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_2', content: '本文2' }),
    makeArticle({ lawNum: 'n1', uniqueAnchor: 'Main_Article_3', content: '本文3' }),
  ];
  // 選別器は 5 件以下なので全件通す。レポートは [1] と [3] のみ引用する。
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', '# T\n本文 [1] と [3]。');
  const res = await pipeline.generateReport('民法とは', 'gemma', 'r');
  assert.deepEqual(res.references?.map((r) => r.n), [1, 3]);
});

test('エラー時（法令を特定できず）は構造化メタを付けない', async () => {
  const retriever = new FakeRetriever();
  retriever.candidates = [];
  const pipeline = makePipeline(retriever, '{"law_names":[]}', 'unused');
  const res = await pipeline.generateReport('意味不明クエリ', 'gemma', 'r');
  assert.equal(res.report, ERR_NO_LAW);
  assert.equal(res.references, undefined);
  assert.equal(res.dataAsOf, undefined);
});

test('as_of 解決時は条見出しも解決版へ組み直す（見出しと引用本文の版が食い違わない）', async () => {
  const retriever = new FakeRetriever();
  // 索引側は現行版の見出し（「成年後見人が…」）で位置特定される。
  retriever.byContent = [
    makeArticle({
      lawNum: 'kaisha',
      lawTitle: '会社法',
      uniqueAnchor: 'Main_Article_331_2',
      articleSummary: '成年被後見人が取締役に就任するには、その成年後見人が…',
      content: '現行本文',
    }),
  ];
  retriever.versions.set(versionKey('kaisha', 'Main_Article_331_2'), {
    lawId: 'ID_20281223_x',
    content: '第三百三十一条の二 特定補助人を付する処分の審判を受けた者が取締役に就任するには…',
    articleSummary: '特定補助人を付する処分の審判を受けた者が取締役に就任するには…',
    anchor: null,
    enforceDate: '2028-12-23',
    isFuture: true,
    nextEnforceDate: null,
  });
  const pipeline = makePipeline(retriever, '{"law_names":["会社法"]}', '# T\n本文 [1]。');
  const res = await pipeline.generateReport('取締役の欠格事由は？', 'gemma', 'r', '2029-01-01');
  // 出典行の見出しが将来版の条見出しになり、現行版の見出しは残らない。
  assert.ok(res.references?.[0]?.title.includes('特定補助人'));
  assert.ok(!res.references?.[0]?.title.includes('成年後見人'));
  assert.ok(res.report.includes('会社法 特定補助人'));
  assert.ok(!res.report.includes('成年後見人が取締役に就任するには'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyEnforcement,
  matchByIdentifier,
  matchExactTitles,
  resolveLawMatch,
} from '../../../src/lib/lawRag/lawMatchResolver.js';
import {
  extractLawIdentifier,
  identifierKey,
  normalizeLawName,
} from '../../../src/lib/lawRag/lawNameIdentifier.js';
import type {
  ArticleKey,
  ArticleWithSummary,
  FullArticle,
  LawCandidate,
  LawEnforcementStatus,
  LawRagMeta,
  LawRetrieverLike,
  LawTitleEntry,
  ResolvedVersion,
} from '../../../src/repositories/lawRetriever.js';

function entry(lawNum: string, lawTitle: string): LawTitleEntry {
  return {
    lawNum,
    lawTitle,
    normalized: normalizeLawName(lawTitle),
    identifier: identifierKey(extractLawIdentifier(lawTitle)),
  };
}

function status(over: Partial<LawEnforcementStatus>): LawEnforcementStatus {
  return {
    lawNum: 'n1',
    lawTitle: '民法',
    currentMainArticles: 10,
    futureMainArticles: 0,
    earliestFutureEnforceDate: null,
    enforcementClause: null,
    ...over,
  };
}

class Fake implements LawRetrieverLike {
  titleIndex: LawTitleEntry[] = [];
  enforcement: LawEnforcementStatus[] = [];
  titleCandidates: LawCandidate[] = [];
  async getLawTitleIndex(): Promise<LawTitleEntry[]> {
    return this.titleIndex;
  }
  async getLawEnforcementStatus(lawNums: string[]): Promise<LawEnforcementStatus[]> {
    return this.enforcement.filter((e) => lawNums.includes(e.lawNum));
  }
  async searchLawTitlesHybrid(): Promise<LawCandidate[]> {
    return this.titleCandidates;
  }
  async getFutureArticlesByLawNums(): Promise<ArticleWithSummary[]> {
    return [];
  }
  async resolveLawNums(): Promise<string[]> {
    return [];
  }
  async searchArticlesByContentInLaws(): Promise<ArticleWithSummary[]> {
    return [];
  }
  async getArticlesByNearestLaw(): Promise<ArticleWithSummary[]> {
    return [];
  }
  async searchLawsByQuery(): Promise<LawCandidate[]> {
    return [];
  }
  async getArticlesByLawNums(): Promise<ArticleWithSummary[]> {
    return [];
  }
  async getFullArticles(): Promise<FullArticle[]> {
    return [];
  }
  async resolveVersionsAsOf(_keys: ArticleKey[], _asOf: string): Promise<Map<string, ResolvedVersion>> {
    return new Map();
  }
  async getLawRagMeta(): Promise<LawRagMeta | null> {
    return null;
  }
}

test('matchExactTitles: 正規化完全一致（段2-0）', () => {
  const index = [entry('n1', '民法'), entry('n2', '刑法')];
  assert.deepEqual(matchExactTitles(index, ['民法 ']).map((e) => e.lawNum), ['n1']);
  assert.deepEqual(matchExactTitles(index, ['商法']), []);
});

test('matchByIdentifier: 固有部分の完全一致（段2-2）は同族を拾い別主題を拾わない', () => {
  const index = [entry('n1', '労働基準法'), entry('n2', '労働基準法施行規則'), entry('n3', '労働契約法')];
  assert.deepEqual(
    matchByIdentifier(index, ['労働基準法']).map((e) => e.lawNum),
    ['n1', 'n2'],
  );
});

test('classifyEnforcement: 本則が 1 条も施行されていない法令だけを施行予定とする', () => {
  const { current, pending } = classifyEnforcement([
    status({ lawNum: 'cur', currentMainArticles: 5, futureMainArticles: 3 }),
    status({ lawNum: 'pend', currentMainArticles: 0, futureMainArticles: 19 }),
    // 本則を持たない法令（廃止政令等・実測 42 件）は未施行ではない。
    status({ lawNum: 'suppl', currentMainArticles: 0, futureMainArticles: 0 }),
  ]);
  assert.deepEqual(current.map((s) => s.lawNum), ['cur', 'suppl']);
  assert.deepEqual(pending.map((s) => s.lawNum), ['pend']);
});

test('resolveLawMatch: 法令名マスタが空なら null（呼び出し側は従来経路へ）', async () => {
  const r = new Fake();
  assert.equal(await resolveLawMatch(r, 'なんでもよい', ['民法']), null);
});

test('resolveLawMatch: 完全一致した現行法令は【現行】', async () => {
  const r = new Fake();
  r.titleIndex = [entry('n1', '民法')];
  r.enforcement = [status({ lawNum: 'n1', lawTitle: '民法' })];
  const m = await resolveLawMatch(r, '消滅時効は', ['民法']);
  assert.ok(m);
  assert.equal(m.verdict, 'current');
  assert.equal(m.stage, '2-0');
  assert.deepEqual(m.lawNums, ['n1']);
});

test('resolveLawMatch: 本則が未施行の法令は【施行予定】（UC2・上流に無い応答）', async () => {
  const r = new Fake();
  r.titleIndex = [entry('b1', '防災庁設置法')];
  r.enforcement = [
    status({
      lawNum: 'b1',
      lawTitle: '防災庁設置法',
      currentMainArticles: 0,
      futureMainArticles: 19,
      earliestFutureEnforceDate: '2026-12-31',
      enforcementClause: 'この法律は、令和八年十二月三十一日までの間において政令で定める日から施行する。',
    }),
  ];
  const m = await resolveLawMatch(r, '防災庁の所掌事務は', ['防災庁設置法']);
  assert.ok(m);
  assert.equal(m.verdict, 'pending');
  assert.equal(m.pending[0]?.earliestFutureEnforceDate, '2026-12-31');
});

test('resolveLawMatch: 段1 が沈黙した経路は候補の固有部分がクエリに出るかで採否を決める', async () => {
  const r = new Fake();
  r.titleIndex = [entry('b1', '防災庁設置法'), entry('f1', '復興庁設置法')];
  r.titleCandidates = [
    { lawNum: 'b1', lawTitle: '防災庁設置法', score: 0.25 },
    { lawNum: 'f1', lawTitle: '復興庁設置法', score: 0.06 },
  ];
  r.enforcement = [
    status({ lawNum: 'b1', lawTitle: '防災庁設置法', currentMainArticles: 0, futureMainArticles: 19 }),
    status({ lawNum: 'f1', lawTitle: '復興庁設置法' }),
  ];
  const m = await resolveLawMatch(r, '防災庁はもう設置されていますか', []);
  assert.ok(m);
  assert.equal(m.stage, '2-3');
  assert.equal(m.verdict, 'pending');
  assert.deepEqual(m.lawNums, ['b1']);
  // 復興庁設置法は固有部分がクエリに出ないので棄却され、ログ用に残る。
  assert.deepEqual(m.rejected.map((c) => c.lawTitle), ['復興庁設置法']);
});

test('resolveLawMatch: 段2-Q＝利用者が名乗った法令が手元に無ければ、推定器が実在法令を挙げていても【該当なし】', async () => {
  const r = new Fake();
  r.titleIndex = [entry('m1', '民法'), entry('c1', '著作権法')];
  r.enforcement = [status({ lawNum: 'm1', lawTitle: '民法' })];
  // 推定器は実在の別法令を挙げている（実測：「人工知能人格権法の適用範囲は」→ 民法 / 著作権法）。
  const m = await resolveLawMatch(r, '人工知能人格権法の適用範囲は', ['民法', '著作権法'], ['人工知能人格権法']);
  assert.ok(m);
  assert.equal(m.verdict, 'none');
  assert.equal(m.stage, '2-Q');
});

test('resolveLawMatch: 段2-Q は名乗った法令が手元にあれば素通りする', async () => {
  const r = new Fake();
  r.titleIndex = [entry('m1', '民法')];
  r.enforcement = [status({ lawNum: 'm1', lawTitle: '民法' })];
  const m = await resolveLawMatch(r, '民法第七百九条は', ['民法'], ['民法']);
  assert.ok(m);
  assert.equal(m.verdict, 'current');
  assert.equal(m.stage, '2-0');
});

test('resolveLawMatch: 固有部分が一致する候補が無ければ【該当なし】（条文を出さない）', async () => {
  const r = new Fake();
  r.titleIndex = [entry('u1', '宇宙基本法')];
  r.titleCandidates = [{ lawNum: 'u1', lawTitle: '宇宙基本法', score: 0.2 }];
  const m = await resolveLawMatch(r, '宇宙移民法の要件は', ['宇宙移民法']);
  assert.ok(m);
  assert.equal(m.verdict, 'none');
  assert.equal(m.stage, '2-3');
  assert.deepEqual(m.lawNums, []);
  assert.deepEqual(m.rejected.map((c) => c.lawTitle), ['宇宙基本法']);
});

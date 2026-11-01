import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyEnforcement,
  findLawTitlesInQuery,
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
    // 本則を持たない法令（本則が空で附則だけの法令・実測 1 件）は未施行ではない。
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

// ── findLawTitlesInQuery ───────────────────────────────

const titlesIn = (index: LawTitleEntry[], query: string): string[] =>
  findLawTitlesInQuery(index, query).map((m) => m.lawTitle);

test('findLawTitlesInQuery: 重なる題名は長いほうを採る', () => {
  const index = [entry('l1', '労働基準法'), entry('l2', '労働基準法施行規則')];
  assert.deepEqual(titlesIn(index, '労働基準法施行規則第五条の内容は'), ['労働基準法施行規則']);
  assert.deepEqual(titlesIn(index, '労働基準法の休憩時間の規定は'), ['労働基準法']);
});

test('findLawTitlesInQuery: 2 文字の題名も拾い、複数の題名を出現順に返す', () => {
  const index = [entry('c1', '会社法'), entry('m1', '民法')];
  assert.deepEqual(titlesIn(index, '民法と会社法の違いを教えて'), ['民法', '会社法']);
});

test('findLawTitlesInQuery: 題名の直前が漢字・カタカナなら当てない（別の語の中の短い題名を拾わない）', () => {
  const index = [entry('m1', '民法')];
  assert.deepEqual(titlesIn(index, '移民法について教えて'), []);
  assert.deepEqual(titlesIn(index, '宇宙移民法の要件は'), []);
  assert.deepEqual(titlesIn(index, '改正民法の施行日は'), []);
});

test('findLawTitlesInQuery: ひらがなを含む題名を、語の切れ目に関係なくそのまま見つける', () => {
  const index = [entry('k1', '公益信託に関する法律'), entry('k2', '公益信託に関する法律施行規則')];
  assert.deepEqual(titlesIn(index, '公益信託に関する法律施行規則の内容を教えて'), ['公益信託に関する法律施行規則']);
});

test('findLawTitlesInQuery: 問いは NFKC と空白除去だけで比べる', () => {
  const index = [entry('k2', '公益信託に関する法律施行規則')];
  assert.deepEqual(titlesIn(index, '公益信託に関する　法律施行規則 の内容'), ['公益信託に関する法律施行規則']);
});

test('findLawTitlesInQuery: 括弧書きを含む題名は、括弧ごと書いても括弧の中だけ書いても見つける', () => {
  const title = '昭和六年法律第八号（特別会計ノ恩給負担金ヲ一般会計ニ繰入ルルコトニ関スル法律）';
  const index = [entry('s1', title)];
  assert.deepEqual(titlesIn(index, `${title}の内容は`), [title]);
  assert.deepEqual(titlesIn(index, '特別会計ノ恩給負担金ヲ一般会計ニ繰入ルルコトニ関スル法律の内容は'), [title]);
});

test('findLawTitlesInQuery: 「令和◯年…第◯号」を含む題名を、正規化で崩れても中の短い題名に取り違えない', () => {
  const long =
    '令和五年度に特定認定事業者が海上運送法第三十五条第一項の規定による申請をする場合における同条第三項第五号の基準を定める省令';
  // normalizeLawName は「令和五年度…第五号」を制定番号として落とすので、正規化した形だけでは問いに現れない。
  assert.notEqual(normalizeLawName(long), long);
  const index = [entry('k1', '海上運送法'), entry('k2', long)];
  assert.deepEqual(titlesIn(index, `${long}の内容は`), [long]);
});

test('findLawTitlesInQuery: 同じ長さで重なるときは先に出たほうを採る', () => {
  const index = [entry('x1', 'あい法'), entry('x2', '法うえ')];
  assert.deepEqual(titlesIn(index, 'あい法うえ'), ['あい法']);
});

test('findLawTitlesInQuery: 題名を含まない問いや空のマスタは空を返す', () => {
  const index = [entry('b1', '防災庁設置法')];
  assert.deepEqual(titlesIn(index, '防災庁はもう設置されていますか'), []);
  assert.deepEqual(titlesIn([], '民法の内容は'), []);
});

// ── resolveLawMatch：問いの本文に書かれた題名 ─────────────

const SHOREI =
  '医療情報基盤・診療報酬審査支払機構の介護保険関係業務に係る業務方法書に記載すべき事項を定める省令';

test('resolveLawMatch: 題名を正式名称で問えば、推定が空でも段2-0 で決まる', async () => {
  const r = new Fake();
  r.titleIndex = [entry('s1', SHOREI)];
  r.enforcement = [status({ lawNum: 's1', lawTitle: SHOREI })];
  const m = await resolveLawMatch(r, `${SHOREI}の内容を教えて`, [], []);
  assert.ok(m);
  assert.equal(m.verdict, 'current');
  assert.equal(m.stage, '2-0');
  assert.deepEqual(m.lawNums, ['s1']);
  assert.deepEqual(m.queryTitles.map((t) => t.lawTitle), [SHOREI]);
});

test('resolveLawMatch: 切り出し語が題名の切れ端でも、題名が見つかれば段2-Q で【該当なし】にしない', async () => {
  const r = new Fake();
  r.titleIndex = [entry('k1', '公益信託に関する法律'), entry('k2', '公益信託に関する法律施行規則')];
  r.enforcement = [status({ lawNum: 'k2', lawTitle: '公益信託に関する法律施行規則' })];
  // 「法律施行規則」は問いから切り出した語（題名の切れ端）で、手元のどの法令にも当たらない。
  const m = await resolveLawMatch(r, '公益信託に関する法律施行規則の内容を教えて', [], ['法律施行規則']);
  assert.ok(m);
  assert.equal(m.verdict, 'current');
  assert.equal(m.stage, '2-0');
  assert.deepEqual(m.lawNums, ['k2']);
});

test('resolveLawMatch: 推定器が実在しない名前を挙げても、問いに書かれた題名で段2-0 に当たる', async () => {
  const title = '国家社会機能継続性確保施策及び副首都の整備に係る施策の推進に関する法律';
  const r = new Fake();
  r.titleIndex = [entry('h1', title)];
  r.enforcement = [status({ lawNum: 'h1', lawTitle: title })];
  const m = await resolveLawMatch(r, `${title}の目的を教えて`, ['副首都整備推進法'], []);
  assert.ok(m);
  assert.equal(m.verdict, 'current');
  assert.equal(m.stage, '2-0');
  assert.deepEqual(m.lawNums, ['h1']);
});

test('resolveLawMatch: 見つかった題名には施行令・施行規則も補って当てる', async () => {
  const r = new Fake();
  r.titleIndex = [entry('l1', '労働基準法'), entry('l2', '労働基準法施行規則')];
  r.enforcement = [
    status({ lawNum: 'l1', lawTitle: '労働基準法' }),
    status({ lawNum: 'l2', lawTitle: '労働基準法施行規則' }),
  ];
  const m = await resolveLawMatch(r, '労働基準法の休憩時間の規定は', [], ['労働基準法']);
  assert.ok(m);
  assert.equal(m.stage, '2-0');
  assert.deepEqual(m.lawNums, ['l1', 'l2']);
});

test('resolveLawMatch: 実在しない法令名だけを名乗った問いは、今までどおり段2-Q で【該当なし】', async () => {
  const r = new Fake();
  r.titleIndex = [entry('m1', '民法'), entry('c1', '著作権法')];
  r.enforcement = [status({ lawNum: 'm1', lawTitle: '民法' })];
  const m = await resolveLawMatch(r, '人工知能人格権法の適用範囲は', ['民法'], ['人工知能人格権法']);
  assert.ok(m);
  assert.equal(m.verdict, 'none');
  assert.equal(m.stage, '2-Q');
  assert.deepEqual(m.queryTitles, []);
});

test('resolveLawMatch: 別の語の中の短い題名は拾わない（「移民法」の中の「民法」）', async () => {
  const r = new Fake();
  r.titleIndex = [entry('m1', '民法')];
  r.enforcement = [status({ lawNum: 'm1', lawTitle: '民法' })];
  const m = await resolveLawMatch(r, '移民法について教えて', [], []);
  assert.ok(m);
  assert.deepEqual(m.queryTitles, []);
  assert.equal(m.verdict, 'none');
  assert.equal(m.stage, '2-3');
});

test('resolveLawMatch: 題名を名乗らない自然文は、今までどおり段2-3 で決まる', async () => {
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
  const m = await resolveLawMatch(r, '防災庁はもう設置されていますか', [], []);
  assert.ok(m);
  assert.deepEqual(m.queryTitles, []);
  assert.equal(m.verdict, 'pending');
  assert.equal(m.stage, '2-3');
  assert.deepEqual(m.lawNums, ['b1']);
});

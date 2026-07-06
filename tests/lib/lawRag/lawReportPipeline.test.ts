import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ArticleWithSummary,
  FullArticle,
  LawCandidate,
  LawRetrieverLike,
} from '../../../src/repositories/lawRetriever.js';
import type { LlmClient } from '../../../src/lib/llm/llmClient.js';
import { LawNameEstimator } from '../../../src/lib/lawRag/lawNameEstimator.js';
import { ArticleSelector } from '../../../src/lib/lawRag/articleSelector.js';
import { ReportGenerator } from '../../../src/lib/lawRag/reportGenerator.js';
import {
  ERR_NO_ARTICLES,
  ERR_NO_LAW,
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
  contentCalls: Array<{ query: string; lawNums: string[]; k: number }> = [];

  async resolveLawNums(lawNames: string[]): Promise<string[]> {
    this.resolveCalls.push(lawNames);
    return this.lawNums;
  }
  async searchArticlesByContentInLaws(
    query: string,
    lawNums: string[],
    k: number,
  ): Promise<ArticleWithSummary[]> {
    this.contentCalls.push({ query, lawNums, k });
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
  const out = await pipeline.generateReport('不法行為とは？', 'gemma', 'r');
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
  const out = await pipeline.generateReport('お金を貸したのに返ってこない', 'gemma', 'r');
  assert.ok(out.includes('## 出典'));
  assert.equal(retriever.resolveCalls.length, 0); // resolve は呼ばれない（フォールバック経路）。
  // 事前ランクは候補法令の law_num で呼ばれる。
  assert.deepEqual(retriever.contentCalls[0]?.lawNums, ['n1']);
});

test('empty estimate + empty fallback → ERR_NO_LAW', async () => {
  const retriever = new FakeRetriever();
  retriever.candidates = [];
  const pipeline = makePipeline(retriever, '{"law_names":[]}', 'unused');
  const out = await pipeline.generateReport('意味不明クエリ', 'gemma', 'r');
  assert.equal(out, ERR_NO_LAW);
});

test('estimate ok but law unresolved (resolve + broader empty) → ERR_NO_ARTICLES', async () => {
  const retriever = new FakeRetriever();
  retriever.lawNums = []; // 法令特定できない。
  const pipeline = makePipeline(retriever, '{"law_names":["民法"]}', 'unused');
  const out = await pipeline.generateReport('民法について', 'gemma', 'r');
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
  const out = await pipeline.generateReport('民法について', 'gemma', 'r');
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
  const out = await pipeline.generateReport('民法の概要', 'gemma', 'r');
  assert.ok(out.includes('全文に差し替え済み'));
});

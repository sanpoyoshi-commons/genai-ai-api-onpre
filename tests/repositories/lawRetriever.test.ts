import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { EmbeddingClient } from '../../src/lib/llm/embeddingClient.js';
import {
  LawRetriever,
  dedupeLawNums,
  egovUrl,
  toVectorLiteral,
} from '../../src/repositories/lawRetriever.js';

// ── 純関数 ──────────────────────────────────────────────

test('toVectorLiteral formats floats and sanitizes non-finite', () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 3]), '[0.1,0.2,3]');
  assert.equal(toVectorLiteral([Number.NaN, Infinity, 1]), '[0,0,1]');
});

test('egovUrl uses base law id (strips version suffix) and optional anchor', () => {
  // law_id は版付き命名（"{id}_{施行日}_{改正番号}"）。先頭が e-Gov の法令 ID。
  assert.equal(
    egovUrl('138AC0000000053_20280613_505AC0000000053', 'Mp-At_50'),
    'https://laws.e-gov.go.jp/law/138AC0000000053#Mp-At_50',
  );
  assert.equal(
    egovUrl('138AC0000000053_20280613_505AC0000000053', null),
    'https://laws.e-gov.go.jp/law/138AC0000000053',
  );
});

test('dedupeLawNums keeps first occurrence order', () => {
  assert.deepEqual(
    dedupeLawNums([{ lawNum: 'A' }, { lawNum: 'B' }, { lawNum: 'A' }, { lawNum: 'C' }]),
    ['A', 'B', 'C'],
  );
});

// ── fake 部品 ──────────────────────────────────────────

let embedInputs: string[][] = [];
const fakeEmbedding: EmbeddingClient = {
  async embed(input) {
    embedInputs.push(input.input);
    return {
      embeddings: input.input.map((_, i) => [0.1 + i, 0.2]),
      model: 'ruri',
      usage: { promptTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    };
  },
};

/** $queryRaw を SQL 内容で振り分ける fake prisma（タグ付きテンプレート＝(strings, ...values)）。 */
function makePrisma(opts: {
  nearest?: Array<{ law_num: string; law_title: string; score: number }>;
  byQuery?: Array<{ law_num: string; law_title: string; score: number }>;
  articles?: unknown[];
  versions?: unknown[];
  meta?: unknown[];
}): { prisma: PrismaClient; calls: string[] } {
  const calls: string[] = [];
  const prisma = {
    async $queryRaw(strings: TemplateStringsArray, ..._values: unknown[]) {
      const sql = strings.join(' ');
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('law_rag_meta')) {
        return opts.meta ?? [];
      }
      if (sql.includes('next_enforce')) {
        return opts.versions ?? [];
      }
      if (sql.includes('law_size')) {
        return opts.articles ?? [];
      }
      if (sql.includes('LIMIT') && sql.includes('app_laws_master')) {
        // nearest（LIMIT 1）と byQuery（LIMIT k）を分けるため LIMIT 1 を nearest とみなす。
        return sql.includes('LIMIT 1') ? (opts.nearest ?? []) : (opts.byQuery ?? []);
      }
      return [];
    },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

// ── getArticlesByNearestLaw ────────────────────────────

test('getArticlesByNearestLaw embeds names, dedupes nearest law_nums, fetches articles', async () => {
  embedInputs = [];
  const { prisma, calls } = makePrisma({
    nearest: [{ law_num: 'L1', law_title: '労働基準法', score: 0.9 }],
    articles: [
      {
        law_num: 'L1',
        law_id: 'id1',
        law_title: '労働基準法',
        unique_anchor: 'Main_Article_32',
        article_summary: '労働時間',
        content: '一週間について四十時間',
        is_summary_only: false,
      },
    ],
  });
  const r = new LawRetriever(fakeEmbedding, prisma);
  const out = await r.getArticlesByNearestLaw(['労働基準法', '労基法']);

  // 2 つの法令名が embed され、各々 nearest 検索される。
  assert.deepEqual(embedInputs, [['労働基準法', '労基法']]);
  // nearest が同一 L1 を返すので dedupe され、articles 取得は 1 回。
  assert.equal(out.length, 1);
  assert.equal(out[0]?.lawNum, 'L1');
  assert.equal(out[0]?.content, '一週間について四十時間');
  assert.equal(out[0]?.isSummaryOnly, false);
  // nearest 検索が 2 回（法令名ごと）＋ articles 1 回。
  const nearestCalls = calls.filter((c) => c.includes('LIMIT 1')).length;
  assert.equal(nearestCalls, 2);
});

test('getArticlesByNearestLaw returns [] for empty input', async () => {
  const { prisma } = makePrisma({});
  const r = new LawRetriever(fakeEmbedding, prisma);
  assert.deepEqual(await r.getArticlesByNearestLaw([]), []);
});

// ── resolveLawNums ─────────────────────────────────────

test('resolveLawNums embeds names and dedupes nearest law_nums', async () => {
  embedInputs = [];
  const { prisma } = makePrisma({ nearest: [{ law_num: 'L1', law_title: '労働基準法', score: 0.9 }] });
  const r = new LawRetriever(fakeEmbedding, prisma);
  const out = await r.resolveLawNums(['労働基準法', '労基法']);
  assert.deepEqual(embedInputs, [['労働基準法', '労基法']]);
  assert.deepEqual(out, ['L1']); // 2 名が同一 L1 → dedupe。
});

test('resolveLawNums returns [] for empty input (embed しない)', async () => {
  embedInputs = [];
  const { prisma } = makePrisma({});
  const r = new LawRetriever(fakeEmbedding, prisma);
  assert.deepEqual(await r.resolveLawNums([]), []);
  assert.deepEqual(embedInputs, []);
});

// ── searchArticlesByContentInLaws（事前ランク） ─────────

test('searchArticlesByContentInLaws embeds query, ranks within laws by content_embedding', async () => {
  embedInputs = [];
  const { prisma, calls } = makePrisma({
    articles: [
      {
        law_num: 'L1',
        law_id: 'id1',
        law_title: '会社法',
        unique_anchor: 'Main_Article_332',
        article_summary: '取締役の任期',
        content: '要約',
        is_summary_only: true,
      },
    ],
  });
  const r = new LawRetriever(fakeEmbedding, prisma);
  const out = await r.searchArticlesByContentInLaws('取締役の任期は？', ['L1', 'L2'], 30);
  assert.deepEqual(embedInputs, [['取締役の任期は？']]); // クエリ自体を embed（prefix なし）。
  assert.equal(out.length, 1);
  assert.equal(out[0]?.lawNum, 'L1');
  assert.equal(out[0]?.isSummaryOnly, true);
  // content_embedding 近傍順で取得する SQL を発行する。
  assert.ok(calls.some((c) => c.includes('content_embedding') && c.includes('ORDER BY')));
});

test('searchArticlesByContentInLaws fuses vector + bigm rankings via RRF', async () => {
  // vector: [A, B]、bigm: [B, C]。B は両方に出るので RRF 最上位、A/C は片側のみ。
  const mk = (n: string, summaryOnly = false) => ({
    law_num: 'L1',
    law_id: `id-${n}`,
    law_title: '個人情報の保護に関する法律',
    unique_anchor: `Main_Article_${n}`,
    article_summary: `要約${n}`,
    content: `本文${n}`,
    is_summary_only: summaryOnly,
  });
  const A = mk('A');
  const B = mk('B');
  const C = mk('C');
  const prisma = {
    async $queryRaw(strings: TemplateStringsArray) {
      const sql = strings.join(' ');
      if (sql.includes('bigm_similarity')) {
        return [B, C];
      }
      if (sql.includes('content_embedding')) {
        return [A, B];
      }
      return [];
    },
  } as unknown as PrismaClient;
  const r = new LawRetriever(fakeEmbedding, prisma);
  const out = await r.searchArticlesByContentInLaws('個人情報を取得する際に特定すべきものは', ['L1'], 30);
  // 3 条文が重複なく返り、両リスト出現の B が先頭。
  assert.deepEqual(out.map((a) => a.uniqueAnchor), [
    'Main_Article_B',
    'Main_Article_A',
    'Main_Article_C',
  ]);
});

test('searchArticlesByContentInLaws falls back to vector-only when bigm query throws', async () => {
  const row = {
    law_num: 'L1',
    law_id: 'id1',
    law_title: '会社法',
    unique_anchor: 'Main_Article_332',
    article_summary: '取締役の任期',
    content: '要約',
    is_summary_only: true,
  };
  const prisma = {
    async $queryRaw(strings: TemplateStringsArray) {
      const sql = strings.join(' ');
      if (sql.includes('bigm_similarity')) {
        throw new Error('pg_bigm unavailable');
      }
      if (sql.includes('content_embedding')) {
        return [row];
      }
      return [];
    },
  } as unknown as PrismaClient;
  const r = new LawRetriever(fakeEmbedding, prisma);
  const out = await r.searchArticlesByContentInLaws('取締役の任期は？', ['L1'], 30);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.uniqueAnchor, 'Main_Article_332');
});

test('searchArticlesByContentInLaws returns [] for blank query / empty laws / k<=0', async () => {
  embedInputs = [];
  const { prisma } = makePrisma({ articles: [{ law_num: 'L1' }] });
  const r = new LawRetriever(fakeEmbedding, prisma);
  assert.deepEqual(await r.searchArticlesByContentInLaws('   ', ['L1'], 30), []);
  assert.deepEqual(await r.searchArticlesByContentInLaws('q', [], 30), []);
  assert.deepEqual(await r.searchArticlesByContentInLaws('q', ['L1'], 0), []);
  assert.deepEqual(embedInputs, []); // どれも embed 前に弾く。
});

// ── searchLawsByQuery（フォールバック・閾値） ────────────

test('searchLawsByQuery filters by minScore', async () => {
  embedInputs = [];
  const { prisma } = makePrisma({
    byQuery: [
      { law_num: 'L1', law_title: '労働基準法', score: 0.8 },
      { law_num: 'L2', law_title: '労働契約法', score: 0.4 },
    ],
  });
  const r = new LawRetriever(fakeEmbedding, prisma);
  const out = await r.searchLawsByQuery('残業の上限は？', 5, 0.5);
  assert.deepEqual(embedInputs, [['残業の上限は？']]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.lawNum, 'L1');
});

test('searchLawsByQuery returns [] for blank query', async () => {
  const { prisma } = makePrisma({ byQuery: [{ law_num: 'L1', law_title: 'x', score: 1 }] });
  const r = new LawRetriever(fakeEmbedding, prisma);
  assert.deepEqual(await r.searchLawsByQuery('   ', 5, 0.5), []);
});

// ── getFullArticles ────────────────────────────────────

test('getFullArticles builds title and e-Gov url', async () => {
  const { prisma } = makePrisma({});
  // getFullArticles は law_size を含まない別 SQL。fake は default [] を返すので、専用に上書き。
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = async () => [
    {
      law_id: 'id1_v',
      law_title: '労働基準法',
      article_summary: '労働時間',
      content: '本文',
      unique_anchor: 'Main_Article_32',
      anchor: 'Mp-At_32',
    },
  ];
  const r = new LawRetriever(fakeEmbedding, prisma);
  const out = await r.getFullArticles(['L1'], ['Main_Article_32']);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.title, '労働基準法 労働時間');
  assert.equal(out[0]?.url, 'https://laws.e-gov.go.jp/law/id1#Mp-At_32');
  assert.equal(out[0]?.content, '本文');
});

test('getFullArticles returns [] when either list is empty', async () => {
  const { prisma } = makePrisma({});
  const r = new LawRetriever(fakeEmbedding, prisma);
  assert.deepEqual(await r.getFullArticles([], ['a']), []);
  assert.deepEqual(await r.getFullArticles(['L1'], []), []);
});

// ── as-of: resolveVersionsAsOf ─────────────────

test('resolveVersionsAsOf maps rows into a keyed version map', async () => {
  const { prisma, calls } = makePrisma({
    versions: [
      {
        law_num: 'N1',
        unique_anchor: 'Main_Article_2',
        law_id: 'ID9_20280401_x',
        content: '未施行本則',
        article_summary: null,
        anchor: null,
        enforce_date: '2028-04-01',
        is_future: true,
        next_enforce: null,
      },
    ],
  });
  const r = new LawRetriever(fakeEmbedding, prisma);
  const map = await r.resolveVersionsAsOf(
    [{ lawNum: 'N1', uniqueAnchor: 'Main_Article_2' }],
    '2030-01-01',
  );
  const v = map.get('N1 Main_Article_2') ?? map.get('N1 Main_Article_2');
  assert.ok(v, 'resolved version present');
  assert.equal(v?.lawId, 'ID9_20280401_x');
  assert.equal(v?.content, '未施行本則');
  assert.equal(v?.enforceDate, '2028-04-01');
  assert.equal(v?.isFuture, true);
  // as_of の版解決は dwh_laws への 1 クエリ（next_enforce を含む）で行う。
  assert.ok(calls.some((c) => c.includes('next_enforce')));
});

test('resolveVersionsAsOf: 空キー/不正日付は DB を触らず空マップ', async () => {
  const { prisma, calls } = makePrisma({ versions: [{ law_num: 'x' }] });
  const r = new LawRetriever(fakeEmbedding, prisma);
  assert.equal((await r.resolveVersionsAsOf([], '2030-01-01')).size, 0);
  assert.equal(
    (await r.resolveVersionsAsOf([{ lawNum: 'N1', uniqueAnchor: 'a' }], 'bad-date')).size,
    0,
  );
  assert.equal(calls.length, 0);
});

// ── as-of: getLawRagMeta（キャッシュ） ──────────

test('getLawRagMeta reads once and caches (single-row meta)', async () => {
  const { prisma, calls } = makePrisma({
    meta: [{ egov_fetch_date: '2026-08-01', release_tag: 'law-rag-20260802' }],
  });
  const r = new LawRetriever(fakeEmbedding, prisma);
  const m1 = await r.getLawRagMeta();
  const m2 = await r.getLawRagMeta();
  assert.deepEqual(m1, { egovFetchDate: '2026-08-01', releaseTag: 'law-rag-20260802' });
  assert.deepEqual(m2, m1);
  // 2 回呼んでも DB は 1 回だけ（プロセス内キャッシュ）。
  assert.equal(calls.filter((c) => c.includes('law_rag_meta')).length, 1);
});

test('getLawRagMeta returns null when meta absent (焼き込みなし＝as-of 導入前と同一)', async () => {
  const { prisma } = makePrisma({ meta: [] });
  const r = new LawRetriever(fakeEmbedding, prisma);
  assert.equal(await r.getLawRagMeta(), null);
});

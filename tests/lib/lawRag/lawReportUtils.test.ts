import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArticleWithSummary, FullArticle } from '../../../src/repositories/lawRetriever.js';
import { enforceDateFromLawId } from '../../../src/repositories/lawRetriever.js';
import {
  buildReferenceMetas,
  buildReferences,
  convertCitationToExternalLink,
  ENFORCE_DATE_UNDECIDED,
  filterReferencesByCitations,
  finalizeReport,
  formatEnforceDate,
  formatReference,
  formatReferenceForPrompt,
  normalizeContent,
  resolveCitedReferences,
  sanitizeMermaidContent,
  toFullArticles,
  versionMetaSuffix,
} from '../../../src/lib/lawRag/lawReportUtils.js';

function makeFull(n: number, url = `https://laws.e-gov.go.jp/law/id${n}`): FullArticle {
  return {
    lawId: `id${n}`,
    title: `法令${n} 第${n}条`,
    content: `本文${n}`,
    uniqueAnchor: `Main_Article_${n}`,
    anchor: null,
    url,
  };
}

// ── as-of: 施行日プレースホルダ／版メタ ──────────

test('formatEnforceDate: プレースホルダ年（>=2100）は施行日未定ラベルへ変換', () => {
  assert.equal(formatEnforceDate('2028-04-01'), '2028-04-01');
  assert.equal(formatEnforceDate('2117-12-31'), ENFORCE_DATE_UNDECIDED);
  assert.equal(formatEnforceDate('2100-01-01'), ENFORCE_DATE_UNDECIDED);
  assert.equal(formatEnforceDate(null), '');
  assert.equal(formatEnforceDate(undefined), '');
});

test('versionMetaSuffix: メタ無し（既定モード）は空文字＝as-of 導入前と同一の出典行', () => {
  assert.equal(versionMetaSuffix(makeFull(1)), '');
});

test('versionMetaSuffix: 施行日・未施行・改正予定を組み立てる', () => {
  assert.equal(
    versionMetaSuffix({ ...makeFull(1), enforceDate: '2028-04-01', isFuture: true, nextEnforceDate: '2030-01-01' }),
    '（施行日: 2028-04-01・未施行・改正予定: 2030-01-01 施行）',
  );
  // 現行（施行済）＋改正予定あり。
  assert.equal(
    versionMetaSuffix({ ...makeFull(1), enforceDate: '2020-04-01', isFuture: false, nextEnforceDate: '2028-04-01' }),
    '（施行日: 2020-04-01・改正予定: 2028-04-01 施行）',
  );
  // プレースホルダ施行日は未定ラベル（「施行日:」を付けない）。
  assert.equal(
    versionMetaSuffix({ ...makeFull(1), enforceDate: '2117-12-31', isFuture: true, nextEnforceDate: null }),
    '（施行日未定（政令委任等）・未施行）',
  );
});

test('finalizeReport: dataAsOfLine を渡すと出典節の先頭へ焼き込む', () => {
  const out = finalizeReport('本文 [1]。', [makeFull(1)], 'データ基準日: 2026-08-01時点のe-Gov法令データ（law-rag-20260802）');
  assert.ok(out.includes('## 出典'));
  // データ基準日は「## 出典」の直後・整形済み参照（🔗）より前に置かれる。
  assert.ok(out.indexOf('## 出典') < out.indexOf('データ基準日'));
  assert.ok(out.indexOf('データ基準日') < out.indexOf('🔗'));
});

test('finalizeReport: dataAsOfLine 未指定は as-of 導入前と同一（データ基準日なし）', () => {
  const out = finalizeReport('本文 [1]。', [makeFull(1)]);
  assert.ok(!out.includes('データ基準日'));
});

// ── normalizeContent ───────────────────────────────────

test('normalizeContent collapses newlines + ideographic spaces and truncates', () => {
  assert.equal(normalizeContent('あ\n　　いう'), 'あ いう');
  assert.equal(normalizeContent('x'.repeat(300)).length, 200);
});

// ── format ─────────────────────────────────────────────

test('formatReferenceForPrompt labels e-laws and includes full content', () => {
  assert.equal(
    formatReferenceForPrompt(0, makeFull(1)),
    '[1] 【e-laws公式条文】 法令1 第1条\n本文1',
  );
});

test('formatReference renders linked title with content blockquote', () => {
  const out = formatReference(2, makeFull(3));
  assert.ok(out.startsWith('[3] 🔗 **[法令3 第3条]('));
  assert.ok(out.includes('> 本文3...'));
});

// ── toFullArticles ─────────────────────────────────────

test('toFullArticles keeps only articles with content and builds e-Gov URL', () => {
  const articles: ArticleWithSummary[] = [
    {
      lawNum: 'n1',
      lawId: '405AC0000000088_x',
      lawTitle: '民法',
      uniqueAnchor: 'Main_Article_709',
      articleSummary: '不法行為',
      content: '本文',
      isSummaryOnly: false,
    },
    {
      lawNum: 'n2',
      lawId: 'id2',
      lawTitle: '空法',
      uniqueAnchor: 'Main_Article_1',
      articleSummary: null,
      content: null,
      isSummaryOnly: false,
    },
  ];
  const full = toFullArticles(articles);
  assert.equal(full.length, 1);
  assert.equal(full[0]?.title, '民法');
  assert.equal(full[0]?.url, 'https://laws.e-gov.go.jp/law/405AC0000000088');
});

// ── buildReferences ────────────────────────────────────

test('buildReferences joins prompt-format entries (articles only)', () => {
  const { searchResults, referencesText } = buildReferences([makeFull(1), makeFull(2)]);
  assert.equal(searchResults.length, 2);
  assert.ok(referencesText.includes('[1] 【e-laws公式条文】'));
  assert.ok(referencesText.includes('[2] 【e-laws公式条文】'));
});

// ── filterReferencesByCitations ────────────────────────

test('filterReferencesByCitations extracts cited numbers (incl. grouped) preserving original index', () => {
  const refs = [makeFull(1), makeFull(2), makeFull(3)];
  const out = filterReferencesByCitations('本文 [1] と [3, 1]。', refs);
  assert.deepEqual(
    out.map(([i]) => i),
    [1, 3],
  );
});

// ── convertCitationToExternalLink ──────────────────────

test('convertCitationToExternalLink links single and grouped, skips mermaid', () => {
  const refs: [number, FullArticle][] = [
    [1, makeFull(1, 'https://a')],
    [3, makeFull(3, 'https://c')],
  ];
  const text = '見よ [1] と [1, 3]。\n```mermaid\nA[ノード 1]\n```';
  const out = convertCitationToExternalLink(text, refs);
  assert.ok(out.includes('[[1]](https://a)'));
  assert.ok(out.includes('[[1]](https://a) [[3]](https://c)'));
  // mermaid 内の [ノード 1] はリンク化されない。
  assert.ok(out.includes('A[ノード 1]'));
});

test('convertCitationToExternalLink leaves unknown numbers as plain', () => {
  const out = convertCitationToExternalLink('参照 [9]。', [[1, makeFull(1)]]);
  assert.ok(out.includes('[9]'));
  assert.ok(!out.includes(']('));
});

// ── sanitizeMermaidContent ─────────────────────────────

test('sanitizeMermaidContent replaces dangerous label chars but preserves arrows', () => {
  const text = '```mermaid\nA[要件(1)] --> B[判断]\n```';
  const out = sanitizeMermaidContent(text);
  assert.ok(out.includes('要件（1）')); // 半角括弧→全角
  assert.ok(out.includes('-->')); // 矢印は維持
});

test('sanitizeMermaidContent leaves non-mermaid text untouched', () => {
  assert.equal(sanitizeMermaidContent('普通の(括弧)文'), '普通の(括弧)文');
});

// ── finalizeReport ─────────────────────────────────────

test('finalizeReport links citations and appends 出典 with only cited refs', () => {
  const refs = [makeFull(1, 'https://a'), makeFull(2, 'https://b'), makeFull(3, 'https://c')];
  const report = '# タイトル\n民法 [1] と 商法 [3]。';
  const out = finalizeReport(report, refs);
  assert.ok(out.includes('[[1]](https://a)'));
  assert.ok(out.includes('[[3]](https://c)'));
  assert.ok(out.includes('## 出典'));
  // 引用された 1,3 のみ出典に出る（2 は出ない）。
  assert.ok(out.includes('[1] 🔗'));
  assert.ok(out.includes('[3] 🔗'));
  assert.ok(!out.includes('[2] 🔗'));
});

test('finalizeReport falls back to all refs when no citation markers', () => {
  const refs = [makeFull(1), makeFull(2)];
  const out = finalizeReport('# タイトル\n引用番号なしの本文。', refs);
  assert.ok(out.includes('## 出典'));
  assert.ok(out.includes('[1] 🔗'));
  assert.ok(out.includes('[2] 🔗'));
});

// ── 構造化メタ（UI バッジ用） ────────────────────────────────────

test('enforceDateFromLawId: law_id 中間フィールドから施行日を導出（想定外形式は null）', () => {
  assert.equal(enforceDateFromLawId('129AC0000000089_20260723_508AC0000000053'), '2026-07-23');
  assert.equal(enforceDateFromLawId('id1'), null); // 中間フィールドなし。
  assert.equal(enforceDateFromLawId('ID_2026072_x'), null); // 8 桁でない。
  assert.equal(enforceDateFromLawId('ID_20261332_x'), null); // 月日が範囲外。
  assert.equal(enforceDateFromLawId(''), null);
});

test('resolveCitedReferences: 引用があればその参照のみ、無ければ全参照へフォールバック', () => {
  const refs = [makeFull(1), makeFull(2), makeFull(3)];
  assert.deepEqual(
    resolveCitedReferences('本文 [1] と [3]。', refs).map(([n]) => n),
    [1, 3],
  );
  assert.deepEqual(
    resolveCitedReferences('引用マーカーなし本文。', refs).map(([n]) => n),
    [1, 2, 3],
  );
});

test('buildReferenceMetas: 既定モードは law_id 由来の施行日・isFuture=false', () => {
  const ref: FullArticle = {
    ...makeFull(1),
    lawId: '129AC0000000089_20260723_508AC0000000053',
  };
  const [meta] = buildReferenceMetas([[2, ref]]);
  assert.equal(meta?.n, 2); // 元の引用番号を保持。
  assert.equal(meta?.title, '法令1 第1条');
  assert.equal(meta?.enforceDate, '2026-07-23');
  assert.equal(meta?.isFuture, false);
  assert.equal(meta?.nextEnforceDate, null);
});

test('buildReferenceMetas: as_of 解決済みの版メタはそのまま載る（導出で上書きしない）', () => {
  const ref: FullArticle = {
    ...makeFull(1),
    lawId: 'ID_20281223_x',
    enforceDate: '2028-12-23',
    isFuture: true,
    nextEnforceDate: '2030-04-01',
  };
  const [meta] = buildReferenceMetas([[1, ref]]);
  assert.equal(meta?.enforceDate, '2028-12-23');
  assert.equal(meta?.isFuture, true);
  assert.equal(meta?.nextEnforceDate, '2030-04-01');
});

test('buildReferenceMetas: 施行日を導出できない law_id は enforceDate=null（バッジ側で施行日を出さない）', () => {
  const [meta] = buildReferenceMetas([[1, makeFull(1)]]);
  assert.equal(meta?.enforceDate, null);
  assert.equal(meta?.isFuture, false);
});

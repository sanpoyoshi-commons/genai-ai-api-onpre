import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArticleWithSummary, FullArticle } from '../../../src/repositories/lawRetriever.js';
import {
  buildReferences,
  convertCitationToExternalLink,
  filterReferencesByCitations,
  finalizeReport,
  formatReference,
  formatReferenceForPrompt,
  normalizeContent,
  sanitizeMermaidContent,
  toFullArticles,
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

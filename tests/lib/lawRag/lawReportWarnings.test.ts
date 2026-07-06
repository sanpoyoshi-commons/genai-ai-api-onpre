import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArticleWithSummary } from '../../../src/repositories/lawRetriever.js';
import {
  bigramSimilarity,
  buildMentionedArticlesPrefix,
  buildSubstitutionWarning,
  checkLawNameDivergence,
} from '../../../src/lib/lawRag/lawReportWarnings.js';

function article(over: Partial<ArticleWithSummary>): ArticleWithSummary {
  return {
    lawNum: 'n',
    lawId: 'id',
    lawTitle: '法令',
    uniqueAnchor: 'Main_Article_1',
    articleSummary: '概要',
    content: '本文',
    isSummaryOnly: false,
    ...over,
  };
}

// ── bigramSimilarity ───────────────────────────────────

test('bigramSimilarity is 1 for identical and 0 for disjoint', () => {
  assert.equal(bigramSimilarity('労働基準法', '労働基準法'), 1);
  assert.equal(bigramSimilarity('民法', '刑法'), 0);
});

test('bigramSimilarity is high for near-identical names', () => {
  assert.ok(bigramSimilarity('個人情報保護法', '個人情報の保護に関する法律') > 0.3);
});

// ── buildSubstitutionWarning ───────────────────────────

test('buildSubstitutionWarning fires when query name diverges from estimate', () => {
  const out = buildSubstitutionWarning(['デジタル行政推進法'], ['情報通信技術を活用した行政の推進等に関する法律']);
  assert.ok(out.includes('読み替え通知'));
  assert.ok(out.includes('デジタル行政推進法'));
});

test('buildSubstitutionWarning empty when names are similar', () => {
  assert.equal(buildSubstitutionWarning(['労働基準法'], ['労働基準法']), '');
});

test('buildSubstitutionWarning empty when either list empty', () => {
  assert.equal(buildSubstitutionWarning([], ['民法']), '');
  assert.equal(buildSubstitutionWarning(['民法'], []), '');
});

// ── checkLawNameDivergence ─────────────────────────────

test('checkLawNameDivergence fires when estimate diverges from retrieved title', () => {
  const out = checkLawNameDivergence(['架空の宇宙人保護法'], [article({ lawTitle: '民法' })]);
  assert.ok(out.includes('警告'));
  assert.ok(out.includes('架空の宇宙人保護法'));
});

test('checkLawNameDivergence empty when titles match well', () => {
  assert.equal(checkLawNameDivergence(['民法'], [article({ lawTitle: '民法' })]), '');
});

// ── buildMentionedArticlesPrefix ───────────────────────

test('buildMentionedArticlesPrefix matches 第N条 by suffix (no Article_20 false match)', () => {
  const articles = [
    article({ uniqueAnchor: 'Main_Article_2', articleSummary: '第2条タイトル' }),
    article({ uniqueAnchor: 'Main_Article_20', articleSummary: '第20条タイトル' }),
  ];
  const out = buildMentionedArticlesPrefix('第2条について', articles);
  assert.ok(out.includes('第2条の正式タイトル: 第2条タイトル'));
  assert.ok(!out.includes('第20条タイトル'));
});

test('buildMentionedArticlesPrefix empty when no article number in query', () => {
  assert.equal(buildMentionedArticlesPrefix('労働時間の上限は？', [article({})]), '');
});

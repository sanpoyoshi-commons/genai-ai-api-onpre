import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArticleWithSummary } from '../../../src/repositories/lawRetriever.js';
import type { LlmClient, LlmGenerateInput } from '../../../src/lib/llm/llmClient.js';
import {
  ArticleSelector,
  buildArticleSummaryList,
  parseAiSelection,
} from '../../../src/lib/lawRag/articleSelector.js';

function makeArticle(n: number): ArticleWithSummary {
  return {
    lawNum: `law-${n}`,
    lawId: `id-${n}`,
    lawTitle: `法令${n}`,
    uniqueAnchor: `Main_Article_${n}`,
    articleSummary: `概要${n}`,
    content: `本文${n}`,
    isSummaryOnly: false,
  };
}

// ── buildArticleSummaryList ────────────────────────────

test('buildArticleSummaryList numbers from 1 and falls back to 概要なし', () => {
  const articles = [makeArticle(1), { ...makeArticle(2), articleSummary: null }];
  const out = buildArticleSummaryList(articles);
  assert.equal(out, '1. 法令1 - 概要1\n2. 法令2 - 概要なし');
});

// ── parseAiSelection ───────────────────────────────────

test('parseAiSelection: comma-separated single line', () => {
  assert.deepEqual(parseAiSelection('1, 4, 7', 10), [1, 4, 7]);
});

test('parseAiSelection: newline + bullet prefixes（純番号のみ採用・"8. 民法" は契約違反で破棄）', () => {
  // "- 2" "* 5" は純番号として採用。"8. 民法"（番号＋条文名）は契約違反として弾く。
  assert.deepEqual(parseAiSelection('- 2\n* 5\n8. 民法', 10), [2, 5]);
});

test('parseAiSelection: out-of-range and non-numeric lines are dropped', () => {
  assert.deepEqual(parseAiSelection('3\n99\nわかりません\n5', 10), [3, 5]);
});

test('parseAiSelection: gemma の散文要約（テーマ番号）は誤抽出せず top-N フォールバック', () => {
  // 実際の失敗パターン：散文＋"1. テーマ\n2. テーマ…"。テーマ番号を条文 index と誤読しない。
  const prose =
    '提示された文章は、日本の労働基準法などの規定です。\n\n主なテーマ：\n1. 労働者の権利と契約に関する事項: 基本ルール。\n2. 労働時間・賃金に関する事項: 規制。\n3. 専門的な適用範囲: 経過措置。';
  assert.deepEqual(parseAiSelection(prose, 30), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('parseAiSelection: dedupes preserving order and caps at 20', () => {
  const raw = Array.from({ length: 25 }, (_, i) => String((i % 22) + 1)).join('\n');
  const out = parseAiSelection(raw, 50);
  assert.equal(out.length, 20);
  assert.deepEqual(out.slice(0, 3), [1, 2, 3]);
});

test('parseAiSelection: empty → fallback top-N（maxIndex<=N は全件）', () => {
  assert.deepEqual(parseAiSelection('', 3), [1, 2, 3]);
});

test('parseAiSelection: 番号なし → content 順 top-N フォールバック', () => {
  // 旧 [先頭,中間,末尾] でなく上位 N 条（候補は事前ランク済＝上位が最も関連）。
  assert.deepEqual(parseAiSelection('説明のみで番号なし', 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(parseAiSelection('説明のみ', 25), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // 上限 N=10
});

// ── ArticleSelector（LlmClient 注入） ───────────────────

test('ArticleSelector returns all when <= threshold (no LLM call)', async () => {
  let called = false;
  const llm: LlmClient = {
    async generate() {
      called = true;
      return '';
    },
    async *generateStream() {},
  };
  const articles = [1, 2, 3, 4, 5].map(makeArticle);
  const selected = await new ArticleSelector(llm).select('q', articles, 'gemma', 'r');
  assert.equal(called, false);
  assert.equal(selected.length, 5);
});

test('ArticleSelector: content-rank floor（上位8条）を常に含め LLM 選別を加点する', () => {
  // candidates>floor の 12 件。LLM が floor 外の 11 を選ぶ → floor[1..8] ∪ [11]。
  let captured: LlmGenerateInput | null = null;
  const llm: LlmClient = {
    async generate(input) {
      captured = input;
      return '11';
    },
    async *generateStream() {},
  };
  return (async () => {
    const articles = Array.from({ length: 12 }, (_, i) => makeArticle(i + 1));
    const selected = await new ArticleSelector(llm).select('残業', articles, 'gemma', 'r');
    assert.deepEqual(
      selected.map((a) => a.lawTitle),
      ['法令1', '法令2', '法令3', '法令4', '法令5', '法令6', '法令7', '法令8', '法令11'],
    );
    assert.equal(captured?.messages.length, 2);
    assert.ok(captured?.messages[1]?.content.includes('残業'));
  })();
});

test('ArticleSelector: gemma が浅い/ズレた選別をしても floor が正解条（上位）を残す', () => {
  // gemma が "3" だけ返す（rank4 の正解条を落とす）状況でも、floor[1..8] が rank4 を含む。
  const llm: LlmClient = {
    async generate() {
      return '3';
    },
    async *generateStream() {},
  };
  return (async () => {
    const articles = Array.from({ length: 30 }, (_, i) => makeArticle(i + 1));
    const selected = await new ArticleSelector(llm).select('q', articles, 'gemma', 'r');
    // 上位 8 条が必ず含まれる（rank4 = 法令4 も生存）。
    assert.deepEqual(
      selected.map((a) => a.lawTitle).slice(0, 8),
      ['法令1', '法令2', '法令3', '法令4', '法令5', '法令6', '法令7', '法令8'],
    );
    assert.equal(selected.length, 8);
  })();
});

test('ArticleSelector falls back to all articles when LLM throws', async () => {
  const llm: LlmClient = {
    async generate() {
      throw new Error('llm down');
    },
    async *generateStream() {},
  };
  const articles = [1, 2, 3, 4, 5, 6].map(makeArticle);
  const selected = await new ArticleSelector(llm).select('q', articles, 'gemma', 'r');
  assert.equal(selected.length, 6);
});

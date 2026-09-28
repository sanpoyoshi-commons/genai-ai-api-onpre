import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractPdfText, PdfTimeoutError } from '../../../src/lib/attachments/pdfText.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/attachments/${name}`, import.meta.url))));

const OPTS = { maxPages: 20, maxChars: 5000, timeoutMs: 20_000 };

test('extractPdfText: ASCII の PDF から文字を取り出す', async () => {
  const result = await extractPdfText(fixture('en-simple.pdf'), OPTS);
  assert.equal(result.text.trim(), 'Hello attachment');
  assert.equal(result.pages, 1);
  assert.equal(result.extractedPages, 1);
  assert.equal(result.truncated, false);
});

test('extractPdfText: 定義済み CMap の日本語 PDF から文字を取り出す（cMapUrl が効いている）', async () => {
  const result = await extractPdfText(fixture('ja-cid.pdf'), OPTS);
  // cMapUrl を渡していないと pdf.js は warn を出して本文が空になる。ここが空なら退行。
  assert.equal(result.text.trim(), '日本語の本文です');
});

test('extractPdfText: ページ数の上限で打ち切り truncated を立てる', async () => {
  const result = await extractPdfText(fixture('many-pages.pdf'), { ...OPTS, maxPages: 3 });
  assert.equal(result.pages, 30);
  assert.equal(result.extractedPages, 3);
  assert.equal(result.truncated, true);
  assert.ok(result.text.includes('PAGE-3.'));
  assert.ok(!result.text.includes('PAGE-4.'));
});

test('extractPdfText: 文字数の上限で打ち切り truncated を立てる', async () => {
  const result = await extractPdfText(fixture('many-pages.pdf'), { ...OPTS, maxChars: 10 });
  assert.equal(result.truncated, true);
  assert.ok(result.extractedPages < 30);
});

test('extractPdfText: 上限に収まるなら truncated は false（全30ページ読む）', async () => {
  const result = await extractPdfText(fixture('many-pages.pdf'), { ...OPTS, maxPages: 30 });
  assert.equal(result.pages, 30);
  assert.equal(result.extractedPages, 30);
  assert.equal(result.truncated, false);
  assert.ok(result.text.includes('PAGE-30.'));
});

test('extractPdfText: 既定のページ上限（20）で 30 ページの PDF は打ち切られる', async () => {
  const result = await extractPdfText(fixture('many-pages.pdf'), OPTS);
  assert.equal(result.extractedPages, 20);
  assert.equal(result.truncated, true);
});

test('extractPdfText: 壊れたファイルは例外（呼び出し側が注記へ変える）', async () => {
  await assert.rejects(() => extractPdfText(fixture('broken.pdf'), OPTS));
});

/** 1回目は 0、2回目以降は大きく進む時計。実時間に依らず必ず期限切れにする。 */
function jumpingClock(): () => number {
  let calls = 0;
  return () => (calls++ === 0 ? 0 : 1_000_000);
}

test('extractPdfText: 時間切れは PdfTimeoutError', async () => {
  await assert.rejects(
    () => extractPdfText(fixture('many-pages.pdf'), { ...OPTS, timeoutMs: 1, now: jumpingClock() }),
    (err: unknown) => err instanceof PdfTimeoutError,
  );
});

test('extractPdfText: 期限内なら時計を注入しても結果は変わらない（seam が本番の判定を変えない）', async () => {
  const result = await extractPdfText(fixture('en-simple.pdf'), { ...OPTS, now: () => 0 });
  assert.equal(result.text.trim(), 'Hello attachment');
  assert.equal(result.truncated, false);
});

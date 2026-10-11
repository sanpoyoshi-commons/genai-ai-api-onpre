import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNOWLEDGE_LIMIT_DEFAULTS, type KnowledgeLimits } from '../../../src/lib/knowledge/config.js';
import { extractKnowledgeText, sniffContainer } from '../../../src/lib/knowledge/extract.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../fixtures/attachments/${name}`, import.meta.url)));
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
const limits = (patch: Partial<KnowledgeLimits> = {}): KnowledgeLimits => ({
  ...KNOWLEDGE_LIMIT_DEFAULTS,
  ...patch,
});

test('sniffContainer: 先頭のバイト列で入れ物を見る', () => {
  assert.equal(sniffContainer(bytesOf('%PDF-1.7')), 'pdf');
  assert.equal(sniffContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'zip');
  assert.equal(sniffContainer(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image');
  assert.equal(sniffContainer(new Uint8Array([0xff, 0xd8, 0xff])), 'image');
  assert.equal(sniffContainer(bytesOf('ただの文字')), 'unknown');
});

test('pdf：本文と形式を返す', async () => {
  const result = await extractKnowledgeText(fixture('ja-cid.pdf'), 'ja.pdf', '', limits());
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') {
    return;
  }
  assert.ok(result.text.length > 0);
  assert.equal(result.mime, 'application/pdf');
  assert.equal(result.extractor, 'pdfjs-dist');
  assert.equal(result.charCount, result.text.length);
});

test('docx・xlsx・html・md：読める形式はそれぞれの抽出器が付く', async () => {
  const docx = await extractKnowledgeText(fixture('doc.docx'), 'doc.docx', '', limits());
  assert.equal(docx.kind, 'ok');
  assert.equal(docx.kind === 'ok' && docx.extractor, 'mammoth');

  const xlsx = await extractKnowledgeText(fixture('sheet.xlsx'), 'sheet.xlsx', '', limits());
  assert.equal(xlsx.kind, 'ok');
  assert.equal(xlsx.kind === 'ok' && xlsx.extractor, 'read-excel-file');

  const html = await extractKnowledgeText(fixture('page.html'), 'page.html', '', limits());
  assert.equal(html.kind, 'ok');
  assert.equal(html.kind === 'ok' && html.extractor, 'node-html-parser');
  // 記録する版はライブラリの版だけでなく抽出規則の版も持つ（同じ版でも取り出し方が変わるため）。
  assert.equal(html.kind === 'ok' && html.extractorVersion, '9.0.4+r2');

  const md = await extractKnowledgeText(bytesOf('# 見出し\n本文'), 'note.md', '', limits());
  assert.equal(md.kind, 'ok');
  assert.equal(md.kind === 'ok' && md.mime, 'text/markdown');
});

test('画像とその他の形式は断る（投入させない）', async () => {
  for (const [name, bytes] of [
    ['photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['deck.pptx', new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
  ] as const) {
    const result = await extractKnowledgeText(bytes, name, '', limits());
    assert.equal(result.kind, 'rejected', name);
    assert.equal(result.kind === 'rejected' && result.reason, 'unsupported', name);
  }
});

test('拡張子と中身が食い違うものは断る', async () => {
  const asText = await extractKnowledgeText(fixture('ja-cid.pdf'), 'note.txt', '', limits());
  assert.equal(asText.kind, 'rejected');
  assert.equal(asText.kind === 'rejected' && asText.reason, 'content_mismatch');

  const asPdf = await extractKnowledgeText(bytesOf('ただの文字'), 'fake.pdf', '', limits());
  assert.equal(asPdf.kind, 'rejected');
  assert.equal(asPdf.kind === 'rejected' && asPdf.reason, 'content_mismatch');
});

test('バイト数の上限を超えたら断る', async () => {
  const result = await extractKnowledgeText(bytesOf('あいうえお'), 'note.txt', '', limits({ maxBytes: 3 }));
  assert.equal(result.kind, 'rejected');
  assert.equal(result.kind === 'rejected' && result.reason, 'too_large');
});

test('文字数の上限を超えたら切り詰めずに断る', async () => {
  const text = 'あ'.repeat(50);
  const over = await extractKnowledgeText(bytesOf(text), 'note.txt', '', limits({ maxChars: 49 }));
  assert.equal(over.kind, 'rejected');
  assert.equal(over.kind === 'rejected' && over.reason, 'too_many_chars');

  // ちょうど上限なら通る（境界で断らない）。
  const exact = await extractKnowledgeText(bytesOf(text), 'note.txt', '', limits({ maxChars: 50 }));
  assert.equal(exact.kind, 'ok');
  assert.equal(exact.kind === 'ok' && exact.charCount, 50);
});

test('ページ数の上限を超えたら断る', async () => {
  const result = await extractKnowledgeText(
    fixture('many-pages.pdf'),
    'many.pdf',
    '',
    limits({ maxPages: 1 }),
  );
  assert.equal(result.kind, 'rejected');
  assert.equal(result.kind === 'rejected' && result.reason, 'too_many_pages');
});

test('読める形式なのに文字が取れないものは failed（原本を残して作り直せるようにする）', async () => {
  const empty = await extractKnowledgeText(bytesOf('   \n '), 'note.txt', '', limits());
  assert.equal(empty.kind, 'failed');
  assert.equal(empty.kind === 'failed' && empty.mime, 'text/plain');

  // 先頭だけ本物の PDF（途中で切れている）＝入れ物は合っているが抽出器が読めない。
  const truncated = fixture('ja-cid.pdf').slice(0, 200);
  const broken = await extractKnowledgeText(truncated, 'broken.pdf', '', limits());
  assert.equal(broken.kind, 'failed');
  assert.equal(broken.kind === 'failed' && broken.extractor, 'pdfjs-dist');
});

test('解析が時間切れなら断る', async () => {
  // 時計を進めて 1 ページ目の後で期限切れにする（抽出器の打ち切りの seam を使う）。
  let t = 0;
  const result = await extractKnowledgeText(
    fixture('many-pages.pdf'),
    'many.pdf',
    '',
    limits({ parseTimeoutMs: 1 }),
    () => {
      t += 10;
      return t;
    },
  );
  assert.equal(result.kind, 'rejected');
  assert.equal(result.kind === 'rejected' && result.reason, 'timeout');
});

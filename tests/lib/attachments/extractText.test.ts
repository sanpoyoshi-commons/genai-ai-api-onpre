import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  detectKind,
  DOCX_MEDIA_TYPE,
  EXTRACTORS,
  extensionOf,
  extractorVersionLabel,
  extractTextFromBytes,
  XLSX_MEDIA_TYPE,
} from '../../../src/lib/attachments/extractText.js';

const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
const limits = { maxPages: 10, maxChars: 1000, parseTimeoutMs: 1000 };

test('detectKind: 拡張子と media type の両方で区分を決める', () => {
  assert.equal(detectKind('a.pdf', ''), 'pdf');
  assert.equal(detectKind('a', 'application/pdf'), 'pdf');
  assert.equal(detectKind('a.docx', ''), 'docx');
  assert.equal(detectKind('a', DOCX_MEDIA_TYPE), 'docx');
  assert.equal(detectKind('a.xlsx', ''), 'xlsx');
  assert.equal(detectKind('a', XLSX_MEDIA_TYPE), 'xlsx');
  assert.equal(detectKind('a.html', ''), 'html');
  assert.equal(detectKind('a.md', ''), 'text');
  assert.equal(detectKind('a.csv', ''), 'text');
  assert.equal(detectKind('a', 'image/png'), 'image');
  assert.equal(detectKind('a.pptx', ''), 'unsupported');
});

test('extensionOf: 点が無ければ空', () => {
  assert.equal(extensionOf('a.TXT'), 'txt');
  assert.equal(extensionOf('noext'), '');
});

test('extractTextFromBytes: text は中身をそのまま返し、抽出器の名前と版を添える', async () => {
  const result = await extractTextFromBytes(bytesOf('本文です'), 'text', limits);
  assert.equal(result.text, '本文です');
  assert.equal(result.status, undefined);
  assert.equal(result.extractor?.name, 'text-decode');
});

test('extractTextFromBytes: 文字が無ければ no_text', async () => {
  const result = await extractTextFromBytes(bytesOf('   \n '), 'text', limits);
  assert.equal(result.status, 'no_text');
  assert.ok(result.note);
});

test('extractTextFromBytes: zip でない docx は読み取れない（zip の検査が先に効く）', async () => {
  const result = await extractTextFromBytes(bytesOf('not a zip'), 'docx', limits);
  assert.equal(result.status, 'error');
});

test('EXTRACTORS: 記録する版の「+ の前」が package.json の依存と対になっている', () => {
  // 依存の版を上げたときに、ここだけ古いまま残ると抽出テキストに嘘の版が記録される。
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  for (const kind of ['pdf', 'docx', 'xlsx', 'html'] as const) {
    const extractor = EXTRACTORS[kind];
    const [libraryVersion] = extractorVersionLabel(extractor).split('+');
    assert.equal(libraryVersion, pkg.dependencies[extractor.name], `${extractor.name} の版が package.json と違う`);
  }
  // text は外部の依存を使わない（Node の TextDecoder）。
  assert.equal(EXTRACTORS.text.name, 'text-decode');
});

test('extractorVersionLabel: ライブラリの版と抽出規則の版を + r で連ねる', () => {
  assert.equal(extractorVersionLabel({ name: 'x', version: '1.2.3', rules: 4 }), '1.2.3+r4');
  // html は <pre> の取り出し方を変えたので 2、ほかの区分は変えていないので 1。
  assert.equal(extractorVersionLabel(EXTRACTORS.html), '9.0.4+r2');
  for (const kind of ['pdf', 'docx', 'xlsx', 'text'] as const) {
    assert.equal(EXTRACTORS[kind].rules, 1, `${kind} の抽出規則の版が 1 でない`);
  }
});

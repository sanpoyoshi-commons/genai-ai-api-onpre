import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkZip,
  inspectZip,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_UNCOMPRESSED,
} from '../../../src/lib/attachments/zipGuard.js';
import { buildZip } from './zipBuilder.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/attachments/${name}`, import.meta.url))));

const text = (s: string) => Buffer.from(s, 'utf8');

// ── 正常系 ───────────────────────────────────────────────────────────────

test('checkZip: 普通の docx・xlsx は通り、展開後の実寸を返す', () => {
  const docx = checkZip(fixture('doc.docx'));
  assert.deepEqual(docx, { ok: true, uncompressed: 1002 });
  const xlsx = checkZip(fixture('sheet.xlsx'));
  assert.equal(xlsx.ok, true);
});

test('checkZip: deflate のエントリも展開して数える', () => {
  const zip = buildZip([{ name: 'a.txt', content: text('あ'.repeat(1000)), deflate: true }]);
  const verdict = checkZip(zip);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.uncompressed, Buffer.byteLength('あ'.repeat(1000)));
});

test('inspectZip: 中央ディレクトリの申告を読む（記録用。判定には使わない）', () => {
  const declared = inspectZip(fixture('doc.docx'));
  assert.equal(declared?.entries, 3);
  assert.equal(declared?.totalUncompressed, 1002);
});

// ── zip 爆弾 ─────────────────────────────────────────────────────────────

test('checkZip: 実際に展開すると上限を超える zip は too_large（申告ではなく実寸で判定）', () => {
  // 200MB のゼロを deflate すると約 200KB。申告も本物なので、宣言だけを見る検査でも実展開でも弾ける。
  const bomb = buildZip([{ name: 'big.bin', content: Buffer.alloc(200 * 1024 * 1024), deflate: true }]);
  assert.ok(bomb.byteLength < 1024 * 1024, `爆弾自体は小さい（${bomb.byteLength} バイト）`);
  assert.deepEqual(checkZip(bomb), { ok: false, reason: 'too_large' });
});

test('checkZip: 申告を小さく偽っても、実際に展開するので止まる', () => {
  // 中央ディレクトリの展開後サイズを 1 と偽った 200MB の爆弾。
  const bomb = buildZip([{ name: 'big.bin', content: Buffer.alloc(200 * 1024 * 1024), deflate: true }]);
  const forged = bomb.slice();
  // 中央ディレクトリの位置を EOCD から引いて、展開後サイズ（+24）を書き換える。
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  const eocd = forged.byteLength - 22;
  const centralOffset = view.getUint32(eocd + 16, true);
  view.setUint32(centralOffset + 24, 1, true);
  assert.equal(inspectZip(forged)?.totalUncompressed, 1, '申告は 1 バイトに見える');
  assert.deepEqual(checkZip(forged), { ok: false, reason: 'too_large' }, '実展開で止まる');
});

test('checkZip: 申告だけ大きく偽った zip は通る（実体が小さいので）', () => {
  // `bomb.docx` は中央ディレクトリにだけ 200MB と書いてある。実体は数百バイト。
  assert.ok((inspectZip(fixture('bomb.docx'))?.totalUncompressed ?? 0) > MAX_ZIP_TOTAL_UNCOMPRESSED);
  const verdict = checkZip(fixture('bomb.docx'));
  assert.equal(verdict.ok, true, '宣言だけを見ていた頃は誤って弾いていた');
  assert.ok(verdict.ok && verdict.uncompressed < 1000);
});

// ── 異常系 ───────────────────────────────────────────────────────────────

test('checkZip: 暗号化されたエントリは解析させない', () => {
  const zip = buildZip([{ name: 'a.txt', content: text('x'), forceFlags: 0x0001 }]);
  assert.deepEqual(checkZip(zip), { ok: false, reason: 'unreadable' });
});

test('checkZip: 0（無圧縮）と 8（deflate）以外の圧縮方式は解析させない', () => {
  const zip = buildZip([{ name: 'a.txt', content: text('x'), forceMethod: 12 }]);
  assert.deepEqual(checkZip(zip), { ok: false, reason: 'unreadable' });
});

test('checkZip: 中央ディレクトリに載っていない領域があれば解析させない（隠れたエントリ）', () => {
  // エントリの後ろに 1KB の隙間を作る。unzipper-esm は先頭からローカルヘッダを順に読むので、
  // ここに別のエントリを置かれると中央ディレクトリ経由の検査をすり抜ける。
  const zip = buildZip([
    { name: 'a.txt', content: text('x'), padAfter: 1024 },
    { name: 'b.txt', content: text('y') },
  ]);
  assert.deepEqual(checkZip(zip), { ok: false, reason: 'unreadable' });
});

test('checkZip: データ記述子ぶんの小さな隙間は許す', () => {
  const zip = buildZip([
    { name: 'a.txt', content: text('x'), padAfter: 16 },
    { name: 'b.txt', content: text('y') },
  ]);
  assert.equal(checkZip(zip).ok, true);
});

test('checkZip: 壊れた zip・zip でないものは unreadable', () => {
  assert.deepEqual(checkZip(fixture('broken.pdf')), { ok: false, reason: 'unreadable' });
  assert.deepEqual(checkZip(new Uint8Array()), { ok: false, reason: 'unreadable' });
});

test('checkZip: deflate として壊れているデータは unreadable', () => {
  const zip = buildZip([{ name: 'a.txt', content: text('x'), deflate: true }]);
  const broken = zip.slice();
  // データ部（ローカルヘッダ 30 ＋ 名前 5 の直後）を壊す。
  broken[36] = (broken[36] ?? 0) ^ 0xff;
  broken[37] = (broken[37] ?? 0) ^ 0xff;
  assert.deepEqual(checkZip(broken), { ok: false, reason: 'unreadable' });
});

test('inspectZip: 中央ディレクトリの位置が壊れていれば読めない', () => {
  const bytes = fixture('doc.docx').slice();
  const eocd = bytes.length - 22;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(eocd + 16, 0x7fffffff, true);
  assert.equal(inspectZip(bytes), undefined);
});

test('上限の定数は意図した値', () => {
  assert.equal(MAX_ZIP_TOTAL_UNCOMPRESSED, 100 * 1024 * 1024);
  assert.equal(MAX_ZIP_ENTRIES, 10000);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeText } from '../../../src/lib/attachments/textDecode.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/attachments/${name}`, import.meta.url))));

test('decodeText: UTF-8 をそのまま読む', () => {
  assert.equal(decodeText(fixture('utf8.txt')), '日本語のテキストです\n');
});

test('decodeText: UTF-8 BOM を取り除く', () => {
  const decoded = decodeText(fixture('utf8-bom.txt'));
  assert.equal(decoded, 'BOM 付きです\n');
  assert.ok(!decoded.startsWith('﻿'), 'BOM が残っていない');
});

test('decodeText: Shift_JIS を読む（UTF-8 として不正なので次へ落ちる）', () => {
  assert.equal(decodeText(fixture('sjis.csv')), '日本語,テスト\n');
});

test('decodeText: EUC-JP を読む', () => {
  assert.equal(decodeText(fixture('eucjp.txt')), '日本語\n');
});

test('decodeText: UTF-16LE の BOM 付きを読む', () => {
  const body = Buffer.from('あい', 'utf16le');
  const bytes = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
  assert.equal(decodeText(bytes), 'あい');
});

test('decodeText: どの encoding でも読めないバイト列は置換文字で返す（例外にしない）', () => {
  // 0xC3 0x28 は UTF-8 として不正。Shift_JIS・EUC-JP でも未定義の並びを混ぜる。
  const bytes = new Uint8Array([0xc3, 0x28, 0x80, 0xfd, 0xfd]);
  const decoded = decodeText(bytes);
  assert.equal(typeof decoded, 'string');
  assert.ok(decoded.length > 0, '空文字にはしない');
});

test('decodeText: 空のバイト列は空文字', () => {
  assert.equal(decodeText(new Uint8Array()), '');
});

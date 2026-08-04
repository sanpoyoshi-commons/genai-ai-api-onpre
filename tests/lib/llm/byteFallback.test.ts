import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createByteFallbackDecoder,
  decodeByteFallback,
} from '../../../src/lib/llm/byteFallback.js';

// 実測（gemma4:e2b）：全角スペース U+3000 が `<0xE3><0x80><0x80>` の文字列として出力される。
const IDEOGRAPHIC_SPACE_RUN = '<0xE3><0x80><0x80>';

test('decodeByteFallback: 全角スペースのバイトトークン列を復号する', () => {
  assert.equal(decodeByteFallback(`２${IDEOGRAPHIC_SPACE_RUN}特定補助人`), '２　特定補助人');
});

test('decodeByteFallback: 1 文字列中の複数箇所を復号する', () => {
  assert.equal(
    decodeByteFallback(`第一条${IDEOGRAPHIC_SPACE_RUN}本文${IDEOGRAPHIC_SPACE_RUN}続き`),
    '第一条　本文　続き',
  );
});

test('decodeByteFallback: 小文字 hex も復号する', () => {
  assert.equal(decodeByteFallback('<0xe3><0x80><0x80>'), '　');
});

test('decodeByteFallback: バイトトークンを含まない文字列は素通し', () => {
  const text = '成年被後見人が取締役に就任するには。';
  assert.equal(decodeByteFallback(text), text);
  assert.equal(decodeByteFallback(''), '');
});

test('decodeByteFallback: 有効な UTF-8 にならないバイト列は元の表記を保つ（壊さない）', () => {
  // 単独の <0xE3> は 3 バイト文字の先頭だけ＝不完全。
  assert.equal(decodeByteFallback('前<0xE3>後'), '前<0xE3>後');
  // ASCII 範囲の単独バイトは有効な UTF-8 なので復号される（正当な変換）。
  assert.equal(decodeByteFallback('<0x41>'), 'A');
});

/** チャンク列を逐次復号器へ流し、結合結果を返す。 */
function streamThrough(chunks: string[]): string {
  const dec = createByteFallbackDecoder();
  let out = '';
  for (const c of chunks) {
    out += dec.push(c);
  }
  return out + dec.flush();
}

test('createByteFallbackDecoder: 一括で流しても復号する', () => {
  assert.equal(streamThrough([`２${IDEOGRAPHIC_SPACE_RUN}特定`]), '２　特定');
});

test('createByteFallbackDecoder: どの位置でチャンク分割されても復号できる', () => {
  const source = `２${IDEOGRAPHIC_SPACE_RUN}特定補助人`;
  for (let i = 1; i < source.length; i++) {
    const chunks = [source.slice(0, i), source.slice(i)];
    assert.equal(streamThrough(chunks), '２　特定補助人', `split at ${i}`);
  }
});

test('createByteFallbackDecoder: 1 文字ずつのチャンクでも復号できる', () => {
  const source = `冒頭${IDEOGRAPHIC_SPACE_RUN}末尾`;
  assert.equal(streamThrough([...source]), '冒頭　末尾');
});

test('createByteFallbackDecoder: 復号対象が無ければ入力をそのまま流す', () => {
  assert.equal(streamThrough(['成年', '被後見人', 'が取締役に']), '成年被後見人が取締役に');
});

test('createByteFallbackDecoder: 途中で終わったバイトトークンは flush で元の表記のまま出す', () => {
  assert.equal(streamThrough(['本文<0x']), '本文<0x');
  assert.equal(streamThrough([`本文${IDEOGRAPHIC_SPACE_RUN}<0xE3>`]), '本文　<0xE3>');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filenameOfKey,
  isSafeOwnedKey,
  knowledgeObjectKey,
  safeObjectName,
} from '../../../src/lib/knowledge/objectKey.js';

test('safeObjectName: 区切りと制御文字を落とす', () => {
  assert.equal(safeObjectName('a/b\\c.txt', 'x'), 'a_b_c.txt');
  assert.equal(safeObjectName('a\u0000b.txt', 'x'), 'ab.txt');
  assert.equal(safeObjectName('  spaced  name .md ', 'x'), 'spaced name .md');
});

test('safeObjectName: 先頭の点を落とし、残らなければ fallback', () => {
  // 区切りを潰してから先頭の点を落とすので、上の階層を指す形は残らない。
  assert.equal(safeObjectName('../../etc/passwd', 'x'), '_.._etc_passwd');
  assert.equal(safeObjectName('...', 'fallback.txt'), 'fallback.txt');
  assert.equal(safeObjectName('', 'fallback.txt'), 'fallback.txt');
});

test('safeObjectName: 長い名前は拡張子を残して切る', () => {
  const name = safeObjectName(`${'あ'.repeat(300)}.pdf`, 'x');
  assert.ok(name.length <= 120);
  assert.ok(name.endsWith('.pdf'));
});

test('knowledgeObjectKey: 所有者が先頭・uuid を挟む 3 セグメント', () => {
  const key = knowledgeObjectKey('u1', 'note.md', 'document');
  const segments = key.split('/');
  assert.equal(segments.length, 3);
  assert.equal(segments[0], 'u1');
  assert.equal(segments[2], 'note.md');
  assert.ok(isSafeOwnedKey(key, 'u1'));
});

test('isSafeOwnedKey: 他人のキー・形の違うキーを断る', () => {
  assert.equal(isSafeOwnedKey('other/uuid/a.txt', 'u1'), false);
  assert.equal(isSafeOwnedKey('u1/a.txt', 'u1'), false); // セグメントが足りない
  assert.equal(isSafeOwnedKey('u1//a.txt', 'u1'), false); // 空のセグメント
  assert.equal(isSafeOwnedKey('u1/../other/a.txt', 'u1'), false);
  assert.equal(isSafeOwnedKey('u1/./a.txt', 'u1'), false);
  assert.equal(isSafeOwnedKey('', 'u1'), false);
  assert.equal(isSafeOwnedKey('u1/uuid/a.txt', 'u1'), true);
  // 先頭が前方一致でも別人なら断る。
  assert.equal(isSafeOwnedKey('u10/uuid/a.txt', 'u1'), false);
});

test('filenameOfKey: 末尾のセグメント', () => {
  assert.equal(filenameOfKey('u1/uuid/note.md'), 'note.md');
  assert.equal(filenameOfKey('note.md'), 'note.md');
});

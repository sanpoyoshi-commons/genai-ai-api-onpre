import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CHUNK_OPTIONS, DEFAULT_SEPARATORS, chunkDocument } from '../../src/lib/rag/chunking.js';

test('見出しで一次分割し headerPath を積む', () => {
  const text = '# 章1\n本文A\n## 節1.1\n本文B';
  const chunks = chunkDocument(text, { maxChunkSize: 1000, chunkOverlap: 0, separators: DEFAULT_SEPARATORS });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.headerPath, '章1');
  assert.equal(chunks[0]?.text, '本文A');
  assert.equal(chunks[0]?.index, 0);
  assert.equal(chunks[1]?.headerPath, '章1 > 節1.1');
  assert.equal(chunks[1]?.text, '本文B');
  assert.equal(chunks[1]?.index, 1);
});

test('同レベル見出しでスタックが正しく入れ替わる', () => {
  const text = '## A\na\n## B\nb';
  const chunks = chunkDocument(text, { maxChunkSize: 1000, chunkOverlap: 0, separators: DEFAULT_SEPARATORS });
  assert.deepEqual(
    chunks.map((c) => c.headerPath),
    ['A', 'B'],
  );
});

test('max を超えるセクションは Recursive 二次分割され各チャンクが max 以内', () => {
  const sentence = `${'あ'.repeat(50)}。`;
  const body = sentence.repeat(10);
  const chunks = chunkDocument(body, { maxChunkSize: 100, chunkOverlap: 10, separators: DEFAULT_SEPARATORS });
  assert.ok(chunks.length > 1, 'should split into multiple chunks');
  for (const c of chunks) {
    assert.ok(c.text.length <= 100, `chunk length ${c.text.length} exceeds max`);
  }
});

test('見出し無し文書は 1 セクションとして扱う（フォールバック）', () => {
  const chunks = chunkDocument('ただのテキスト', {
    maxChunkSize: 1000,
    chunkOverlap: 0,
    separators: DEFAULT_SEPARATORS,
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.headerPath, undefined);
  assert.equal(chunks[0]?.text, 'ただのテキスト');
});

test('空白のみは空配列', () => {
  assert.deepEqual(chunkDocument('   \n  ', DEFAULT_CHUNK_OPTIONS), []);
});

test('日本語句読点 separators で読点・句点境界に割れる', () => {
  const body = `${'x'.repeat(60)}、${'y'.repeat(60)}。${'z'.repeat(60)}`;
  const chunks = chunkDocument(body, { maxChunkSize: 80, chunkOverlap: 0, separators: DEFAULT_SEPARATORS });
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.text.length <= 80);
  }
});

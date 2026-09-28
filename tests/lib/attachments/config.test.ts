import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTACHMENT_LIMIT_DEFAULTS, loadAttachmentLimits } from '../../../src/lib/attachments/config.js';
import { LruCache } from '../../../src/lib/attachments/cache.js';

test('loadAttachmentLimits: env が空なら既定', () => {
  assert.deepEqual(loadAttachmentLimits({}), ATTACHMENT_LIMIT_DEFAULTS);
});

test('loadAttachmentLimits: env の正の整数を採用する', () => {
  const limits = loadAttachmentLimits({
    ATTACHMENT_MAX_CHARS: '100',
    ATTACHMENT_TOTAL_MAX_CHARS: '200',
    ATTACHMENT_MAX_PAGES: '3',
    ATTACHMENT_MAX_BYTES: '4096',
    ATTACHMENT_MAX_FILES: '2',
    ATTACHMENT_MAX_IMAGES: '7',
    ATTACHMENT_PARSE_TIMEOUT_MS: '500',
    ATTACHMENT_CACHE_ENTRIES: '8',
  });
  assert.deepEqual(limits, {
    maxChars: 100,
    totalMaxChars: 200,
    maxPages: 3,
    maxBytes: 4096,
    maxFiles: 2,
    maxImages: 7,
    parseTimeoutMs: 500,
    cacheEntries: 8,
  });
});

test('loadAttachmentLimits: 0・負・非数・空は既定へ落とす（上限を書き間違いで外さない）', () => {
  for (const bad of ['0', '-1', 'abc', '', '  ']) {
    assert.equal(
      loadAttachmentLimits({ ATTACHMENT_MAX_CHARS: bad }).maxChars,
      ATTACHMENT_LIMIT_DEFAULTS.maxChars,
      `"${bad}" は既定に落ちる`,
    );
  }
});

test('loadAttachmentLimits: JUDGE_MAX_STATE_BYTES と同じ intEnv（10進の parseInt）で読む', () => {
  // 判定側と同じ実装に揃えている（2026-09-27 の決定）。小数や後続文字は parseInt の挙動に従う。
  assert.equal(loadAttachmentLimits({ ATTACHMENT_MAX_CHARS: '1.5' }).maxChars, 1);
  assert.equal(loadAttachmentLimits({ ATTACHMENT_MAX_CHARS: ' 42 ' }).maxChars, 42);
  assert.equal(loadAttachmentLimits({ ATTACHMENT_MAX_BYTES: '5242880' }).maxBytes, 5242880);
});

test('コード内の既定値は deploy の compose の既定値と同じ数（2026-09-27 の決定）', () => {
  assert.equal(ATTACHMENT_LIMIT_DEFAULTS.maxChars, 5000);
  assert.equal(ATTACHMENT_LIMIT_DEFAULTS.totalMaxChars, 5000);
  assert.equal(ATTACHMENT_LIMIT_DEFAULTS.maxPages, 20);
  assert.equal(ATTACHMENT_LIMIT_DEFAULTS.maxBytes, 5242880);
  assert.equal(ATTACHMENT_LIMIT_DEFAULTS.maxFiles, 5);
  assert.equal(ATTACHMENT_LIMIT_DEFAULTS.maxImages, 3);
  assert.equal(ATTACHMENT_LIMIT_DEFAULTS.parseTimeoutMs, 10000);
});

test('LruCache: 件数の上限を守り、古いものから捨てる', () => {
  const cache = new LruCache<number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), undefined, '最も古い a が落ちる');
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('LruCache: 参照したものは新しい扱いになる', () => {
  const cache = new LruCache<number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1, '直前に参照した a は残る');
  assert.equal(cache.get('b'), undefined);
});

test('LruCache: 上限 0 なら何も持たない', () => {
  const cache = new LruCache<number>(0);
  cache.set('a', 1);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
});

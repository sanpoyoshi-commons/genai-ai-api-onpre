import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KNOWLEDGE_LIMIT_DEFAULTS,
  loadKnowledgeLimits,
} from '../../../src/lib/knowledge/config.js';

test('loadKnowledgeLimits: env が空なら既定', () => {
  assert.deepEqual(loadKnowledgeLimits({}), KNOWLEDGE_LIMIT_DEFAULTS);
});

test('loadKnowledgeLimits: env の正の整数を採用する', () => {
  const limits = loadKnowledgeLimits({
    KNOWLEDGE_MAX_BYTES: '1024',
    KNOWLEDGE_MAX_CHARS: '2000',
    KNOWLEDGE_MAX_PAGES: '5',
    KNOWLEDGE_PARSE_TIMEOUT_MS: '3000',
    KNOWLEDGE_MAX_CHUNKS: '7',
  });
  assert.deepEqual(limits, {
    maxBytes: 1024,
    maxChars: 2000,
    maxPages: 5,
    parseTimeoutMs: 3000,
    maxChunks: 7,
  });
});

test('loadKnowledgeLimits: 空文字・0 以下・数でないものは既定へ落とす', () => {
  const limits = loadKnowledgeLimits({
    KNOWLEDGE_MAX_BYTES: '',
    KNOWLEDGE_MAX_CHARS: '0',
    KNOWLEDGE_MAX_PAGES: '-1',
    KNOWLEDGE_PARSE_TIMEOUT_MS: 'abc',
    KNOWLEDGE_MAX_CHUNKS: ' ',
  });
  assert.deepEqual(limits, KNOWLEDGE_LIMIT_DEFAULTS);
});

test('既定値は 2026-10-10 に決めた数（deploy の compose の既定値と対で見る）', () => {
  assert.deepEqual(KNOWLEDGE_LIMIT_DEFAULTS, {
    maxBytes: 20971520,
    maxChars: 300000,
    maxPages: 300,
    parseTimeoutMs: 120000,
    maxChunks: 300,
  });
});

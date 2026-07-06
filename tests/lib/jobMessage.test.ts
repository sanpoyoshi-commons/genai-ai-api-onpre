import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { decodeJobMessage, encodeJobMessage } from '../../src/lib/exapp/jobMessage.js';

test('encode→decode で履歴キーがラウンドトリップする', () => {
  const message = {
    teamId: 'team-1',
    exAppId: 'app-1',
    userId: 'user-1',
    createdDate: '2026-05-26T00:00:00.000Z',
  };
  const decoded = decodeJobMessage(encodeJobMessage(message));
  assert.deepEqual(decoded, message);
});

test('必須フィールド欠落は ZodError', () => {
  const body = JSON.stringify({ teamId: 'team-1', exAppId: 'app-1' });
  assert.throws(() => decodeJobMessage(body), ZodError);
});

test('空文字フィールドは ZodError（min(1)）', () => {
  const body = JSON.stringify({ teamId: '', exAppId: 'a', userId: 'u', createdDate: 'd' });
  assert.throws(() => decodeJobMessage(body), ZodError);
});

test('不正 JSON は SyntaxError', () => {
  assert.throws(() => decodeJobMessage('{not json'), SyntaxError);
});

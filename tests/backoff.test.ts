import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_VISIBILITY_SECONDS, backoffVisibilitySeconds } from '../src/lib/queue/backoff.ts';

// バックオフ閾値（240/480/720 超 → 60/300/900 秒、未満は既定 30 秒）。
test('閾値未満は既定 30 秒', () => {
  assert.equal(backoffVisibilitySeconds(0), DEFAULT_VISIBILITY_SECONDS);
  assert.equal(backoffVisibilitySeconds(1), DEFAULT_VISIBILITY_SECONDS);
  assert.equal(backoffVisibilitySeconds(240), DEFAULT_VISIBILITY_SECONDS);
});

test('240 超で 60 秒', () => {
  assert.equal(backoffVisibilitySeconds(241), 60);
  assert.equal(backoffVisibilitySeconds(480), 60);
});

test('480 超で 300 秒', () => {
  assert.equal(backoffVisibilitySeconds(481), 300);
  assert.equal(backoffVisibilitySeconds(720), 300);
});

test('720 超で 900 秒', () => {
  assert.equal(backoffVisibilitySeconds(721), 900);
  assert.equal(backoffVisibilitySeconds(10000), 900);
});

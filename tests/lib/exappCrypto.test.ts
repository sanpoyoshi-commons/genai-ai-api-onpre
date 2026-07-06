import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decryptApiKey, encryptApiKey, parseEncKey } from '../../src/lib/apikey/crypto.js';

test('parseEncKey accepts base64 32B and hex 64', () => {
  const key = randomBytes(32);
  assert.deepEqual(parseEncKey(key.toString('base64')), key);
  assert.deepEqual(parseEncKey(key.toString('hex')), key);
});

test('parseEncKey rejects wrong length', () => {
  assert.throws(() => parseEncKey(randomBytes(16).toString('base64')), /32 bytes/);
});

test('encrypt/decrypt roundtrip', () => {
  const key = randomBytes(32);
  const plaintext = 'sk-secret-こんにちは-1234567890';
  const enc = encryptApiKey(plaintext, key);
  // 暗号文・IV は base64、平文を含まない。
  assert.notEqual(enc.value, plaintext);
  assert.ok(enc.iv.length > 0);
  assert.equal(decryptApiKey(enc, key), plaintext);
});

test('decrypt with wrong key fails (auth tag mismatch)', () => {
  const key = randomBytes(32);
  const enc = encryptApiKey('secret', key);
  assert.throws(() => decryptApiKey(enc, randomBytes(32)));
});

test('each encryption uses a fresh IV', () => {
  const key = randomBytes(32);
  const a = encryptApiKey('same', key);
  const b = encryptApiKey('same', key);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.value, b.value);
});

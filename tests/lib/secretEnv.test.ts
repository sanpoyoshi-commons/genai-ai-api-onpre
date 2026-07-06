import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSecretEnv } from '../../src/lib/secretEnv.js';

const dir = mkdtempSync(join(tmpdir(), 'secretenv-'));
const writeSecret = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

test('readSecretEnv: ${name}_FILE があればファイル内容（trim）を優先', () => {
  const p = writeSecret('s1', '  file-secret\n');
  const env = { FOO: 'env-secret', FOO_FILE: p };
  assert.equal(readSecretEnv(env, 'FOO'), 'file-secret');
});

test('readSecretEnv: _FILE 未設定なら env[name]（trim）', () => {
  assert.equal(readSecretEnv({ FOO: '  env-secret ' }, 'FOO'), 'env-secret');
});

test('readSecretEnv: 未設定は undefined', () => {
  assert.equal(readSecretEnv({}, 'FOO'), undefined);
});

test('readSecretEnv: env 値が空白のみは undefined', () => {
  assert.equal(readSecretEnv({ FOO: '   ' }, 'FOO'), undefined);
});

test('readSecretEnv: _FILE の中身が空（空白のみ）は undefined', () => {
  const p = writeSecret('s2', '   \n');
  assert.equal(readSecretEnv({ FOO_FILE: p }, 'FOO'), undefined);
});

test('readSecretEnv: _FILE 指定があり読めない場合は例外（env へフォールバックしない）', () => {
  const env = { FOO: 'env-secret', FOO_FILE: join(dir, 'does-not-exist') };
  assert.throws(() => readSecretEnv(env, 'FOO'));
});

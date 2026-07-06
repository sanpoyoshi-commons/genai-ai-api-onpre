import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PostgresApiKeyStore } from '../../src/lib/apikey/postgresApiKeyStore.js';

interface Row {
  teamId: string;
  exAppId: string;
  value: string;
  encIv: string | null;
}

/** ex_app_api_keys だけを持つ最小の in-memory fake prisma。 */
function fakePrisma() {
  const rows = new Map<string, Row>();
  const k = (teamId: string, exAppId: string) => `${teamId}::${exAppId}`;
  const client = {
    exAppApiKey: {
      // biome-ignore lint/suspicious/noExplicitAny: テスト用 fake のため型を緩める。
      async findUnique({ where, select }: any) {
        const row = rows.get(k(where.teamId_exAppId.teamId, where.teamId_exAppId.exAppId));
        if (!row) return null;
        return select ? { value: row.value, encIv: row.encIv } : row;
      },
      // biome-ignore lint/suspicious/noExplicitAny: テスト用 fake のため型を緩める。
      async upsert({ where, create, update }: any) {
        const key = k(where.teamId_exAppId.teamId, where.teamId_exAppId.exAppId);
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, { ...existing, value: update.value, encIv: update.encIv });
        } else {
          rows.set(key, { teamId: create.teamId, exAppId: create.exAppId, value: create.value, encIv: create.encIv });
        }
        return rows.get(key);
      },
      // biome-ignore lint/suspicious/noExplicitAny: テスト用 fake のため型を緩める。
      async deleteMany({ where }: any) {
        const existed = rows.delete(k(where.teamId, where.exAppId));
        return { count: existed ? 1 : 0 };
      },
    },
    _rows: rows,
  };
  return client as unknown as PrismaClient & { _rows: Map<string, Row> };
}

test('plaintext roundtrip (no enc key)', async () => {
  const prisma = fakePrisma();
  const store = new PostgresApiKeyStore(prisma, undefined);
  await store.setApiKey('t1', 'a1', 'secret-key');
  assert.equal(await store.getApiKey('t1', 'a1'), 'secret-key');
  // 平文保存＝enc_iv は null。
  assert.equal(prisma._rows.get('t1::a1')?.encIv, null);
  assert.equal(prisma._rows.get('t1::a1')?.value, 'secret-key');
});

test('encrypted roundtrip (with enc key) and value is not plaintext', async () => {
  const prisma = fakePrisma();
  const encKey = randomBytes(32).toString('base64');
  const store = new PostgresApiKeyStore(prisma, encKey);
  await store.setApiKey('t1', 'a1', 'secret-key');
  const stored = prisma._rows.get('t1::a1');
  assert.notEqual(stored?.value, 'secret-key');
  assert.ok(stored?.encIv);
  assert.equal(await store.getApiKey('t1', 'a1'), 'secret-key');
});

test('getApiKey returns null when absent', async () => {
  const store = new PostgresApiKeyStore(fakePrisma(), undefined);
  assert.equal(await store.getApiKey('t1', 'missing'), null);
});

test('setApiKey overwrites (update path)', async () => {
  const store = new PostgresApiKeyStore(fakePrisma(), undefined);
  await store.setApiKey('t1', 'a1', 'old');
  await store.setApiKey('t1', 'a1', 'new');
  assert.equal(await store.getApiKey('t1', 'a1'), 'new');
});

test('deleteApiKey is idempotent', async () => {
  const store = new PostgresApiKeyStore(fakePrisma(), undefined);
  await store.setApiKey('t1', 'a1', 'x');
  await store.deleteApiKey('t1', 'a1');
  assert.equal(await store.getApiKey('t1', 'a1'), null);
  // 不在でも例外なし。
  await store.deleteApiKey('t1', 'a1');
});

test('copy scenario: get from source then set to new id', async () => {
  const store = new PostgresApiKeyStore(fakePrisma(), undefined);
  await store.setApiKey('t1', 'src', 'copied-secret');
  const v = await store.getApiKey('t1', 'src');
  assert.ok(v);
  await store.setApiKey('t1', 'dst', v as string);
  assert.equal(await store.getApiKey('t1', 'dst'), 'copied-secret');
});

test('encrypted value unreadable without enc key throws', async () => {
  const prisma = fakePrisma();
  const encKey = randomBytes(32).toString('base64');
  await new PostgresApiKeyStore(prisma, encKey).setApiKey('t1', 'a1', 'secret');
  const noKeyStore = new PostgresApiKeyStore(prisma, undefined);
  await assert.rejects(() => noKeyStore.getApiKey('t1', 'a1'), /encrypted but/);
});

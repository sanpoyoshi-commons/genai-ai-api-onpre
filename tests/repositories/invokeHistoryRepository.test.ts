import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { InvokeHistoryRepository } from '../../src/repositories/invokeHistoryRepository.js';

/** putObject を記録し getObject で返すだけの最小ストレージ。 */
function makeFakeStorage() {
  const store = new Map<string, Uint8Array>();
  return {
    puts: [] as { bucket: string; key: string }[],
    async putObject(bucket: string, key: string, body: Uint8Array): Promise<void> {
      this.puts.push({ bucket, key });
      store.set(`${bucket}/${key}`, body);
    },
    async getObject(bucket: string, key: string): Promise<Uint8Array> {
      const v = store.get(`${bucket}/${key}`);
      if (!v) {
        throw new Error(`not found: ${bucket}/${key}`);
      }
      return v;
    },
  };
}

/** create が受けた inputs を捕捉し、findUnique でそれを返す最小 Prisma。 */
function makeFakePrisma(captured: { inputs?: unknown }): PrismaClient {
  const createdDate = new Date('2026-06-02T00:00:00.000Z');
  const fake = {
    invokeExAppHistory: {
      async create(args: { data: { teamId: string; exAppId: string; userId: string; inputs: unknown } }) {
        captured.inputs = args.data.inputs;
        return { teamId: args.data.teamId, exAppId: args.data.exAppId, userId: args.data.userId, createdDate };
      },
      async findUnique() {
        return { inputs: captured.inputs, statusUrl: null, externalRequestId: null, status: 'running' };
      },
    },
  };
  return fake as unknown as PrismaClient;
}

const baseInput = { teamId: 't1', exAppId: 'a1', userId: 'u1', teamNameSnapshot: 'T', exAppNameSnapshot: 'A' };

test('large inputs are offloaded to storage and rehydrated on read', async () => {
  const captured: { inputs?: unknown } = {};
  const storage = makeFakeStorage();
  const repo = new InvokeHistoryRepository(makeFakePrisma(captured), storage, 'artifacts');

  const big = { question: 'x'.repeat(20_000) };
  const key = await repo.create({ ...baseInput, inputs: big });

  // DB 行にはマーカ参照のみが入る。
  assert.equal(storage.puts.length, 1);
  assert.equal(storage.puts[0]?.bucket, 'artifacts');
  assert.match(storage.puts[0]?.key ?? '', /^inputs\/t1\/a1\/u1\//);
  assert.ok(
    captured.inputs && typeof captured.inputs === 'object' && '__inputsRef' in (captured.inputs as object),
    'DB inputs should be an offload marker',
  );

  // 読取（findExecution）で透過復元される。
  const ctx = await repo.findExecution({ teamId: 't1', exAppId: 'a1', userId: 'u1', createdDate: key.createdDate });
  assert.deepEqual(ctx?.inputs, big);
});

test('small inputs are stored inline (no offload)', async () => {
  const captured: { inputs?: unknown } = {};
  const storage = makeFakeStorage();
  const repo = new InvokeHistoryRepository(makeFakePrisma(captured), storage, 'artifacts');

  const small = { question: 'hi' };
  await repo.create({ ...baseInput, inputs: small });

  assert.equal(storage.puts.length, 0);
  assert.deepEqual(captured.inputs, small);
});

test('no storage injected: large inputs stored inline (backward compat)', async () => {
  const captured: { inputs?: unknown } = {};
  const repo = new InvokeHistoryRepository(makeFakePrisma(captured));

  const big = { question: 'x'.repeat(20_000) };
  await repo.create({ ...baseInput, inputs: big });

  assert.deepEqual(captured.inputs, big);
});

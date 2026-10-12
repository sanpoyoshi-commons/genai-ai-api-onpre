import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { InvokeHistoryRepository } from '../../src/repositories/invokeHistoryRepository.js';

/** putObject / getObject を記録し、置いたものを返すだけの最小ストレージ。 */
function makeFakeStorage() {
  const store = new Map<string, Uint8Array>();
  return {
    puts: [] as { bucket: string; key: string }[],
    gets: [] as { bucket: string; key: string }[],
    /** 既にストレージ上にあるオブジェクト（他の利用者のものを含む）を置く。 */
    seed(bucket: string, key: string, value: unknown): void {
      store.set(`${bucket}/${key}`, new Uint8Array(Buffer.from(JSON.stringify(value), 'utf8')));
    },
    async putObject(bucket: string, key: string, body: Uint8Array): Promise<void> {
      this.puts.push({ bucket, key });
      store.set(`${bucket}/${key}`, body);
    },
    async getObject(bucket: string, key: string): Promise<Uint8Array> {
      this.gets.push({ bucket, key });
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

// --- 退避マーカの復元範囲 ---------------------------------------------------
//
// inputs は利用者が送った値がそのまま DB に入る（閾値以下なら退避しない）ため、退避マーカの形をした値も
// 保存されうる。復元はその行自身の退避先（退避に使うバケット＋その行の team / exApp / user で作ったキー）に
// 限る。以下は 3 つの読み出し経路（findExecution / findByKey / listByScope）すべてで確かめる。

const INPUTS_BUCKET = 'artifacts';
const STORED_DATE = new Date('2026-06-02T00:00:00.000Z');
const ROW_OWNER = { teamId: 't1', exAppId: 'a1', userId: 'u1' };

/** 既に DB にある 1 行を、3 つの読み出し経路すべてに返す最小 Prisma。 */
function makeStoredRowPrisma(storedInputs: unknown): PrismaClient {
  const row = {
    ...ROW_OWNER,
    createdDate: STORED_DATE,
    teamNameSnapshot: 'T',
    exAppNameSnapshot: 'A',
    inputs: storedInputs,
    outputs: null,
    status: 'running',
    statusUrl: null,
    externalRequestId: null,
  };
  const fake = {
    invokeExAppHistory: {
      async findUnique() {
        return row;
      },
      async findMany() {
        return [row];
      },
    },
  };
  return fake as unknown as PrismaClient;
}

/** findExecution / findByKey / listByScope が返す inputs をまとめて採る。 */
async function readInputsEverywhere(repo: InvokeHistoryRepository): Promise<Record<string, unknown>> {
  const execution = await repo.findExecution({ ...ROW_OWNER, createdDate: STORED_DATE });
  const single = await repo.findByKey(
    ROW_OWNER.teamId,
    ROW_OWNER.exAppId,
    ROW_OWNER.userId,
    String(STORED_DATE.getTime()),
  );
  const listed = await repo.listByScope(ROW_OWNER.teamId, ROW_OWNER.exAppId, ROW_OWNER.userId);
  return {
    findExecution: execution?.inputs,
    findByKey: single?.inputs,
    listByScope: listed.data[0]?.inputs,
  };
}

const OTHER_USER_OBJECT = { secret: 'inputs that belong to another user' };

/** その行の退避先ではないマーカ。いずれもストレージを引きに行ってはならない。 */
const foreignRefs: { name: string; bucket: string; key: string }[] = [
  {
    name: 'another bucket',
    bucket: 'other-bucket',
    key: 'inputs/t1/a1/u1/9ad3a0de-1111-4111-8111-111111111111.json',
  },
  {
    name: "another user's key in the offload bucket",
    bucket: INPUTS_BUCKET,
    key: 'inputs/t1/a1/u2/9ad3a0de-2222-4222-8222-222222222222.json',
  },
  {
    name: 'owner prefix followed by traversal',
    bucket: INPUTS_BUCKET,
    key: 'inputs/t1/a1/u1/../../../u2/9ad3a0de-3333-4333-8333-333333333333.json',
  },
  {
    name: 'owner prefix with a key that is not an offload file name',
    bucket: INPUTS_BUCKET,
    key: 'inputs/t1/a1/u1/not-an-offloaded-file.json',
  },
];

for (const ref of foreignRefs) {
  test(`an inputs marker outside the row's own offload key is not fetched: ${ref.name}`, async () => {
    const storage = makeFakeStorage();
    storage.seed(ref.bucket, ref.key, OTHER_USER_OBJECT);
    const marker = { __inputsRef: `s3://${ref.bucket}/${ref.key}` };
    const repo = new InvokeHistoryRepository(makeStoredRowPrisma(marker), storage, INPUTS_BUCKET);

    const read = await readInputsEverywhere(repo);

    assert.deepEqual(storage.gets, [], 'storage must not be read for a marker outside the row own offload key');
    for (const [path, inputs] of Object.entries(read)) {
      assert.deepEqual(inputs, marker, `${path} must return the stored value as-is`);
    }
  });
}

test("an inputs marker pointing at the row's own offload key is still restored", async () => {
  const storage = makeFakeStorage();
  const key = 'inputs/t1/a1/u1/9ad3a0de-4444-4444-8444-444444444444.json';
  const own = { question: 'the row own offloaded inputs' };
  storage.seed(INPUTS_BUCKET, key, own);
  const marker = { __inputsRef: `s3://${INPUTS_BUCKET}/${key}` };
  const repo = new InvokeHistoryRepository(makeStoredRowPrisma(marker), storage, INPUTS_BUCKET);

  const read = await readInputsEverywhere(repo);

  assert.equal(storage.gets.length, 3, 'each read path restores the offloaded inputs');
  for (const [path, inputs] of Object.entries(read)) {
    assert.deepEqual(inputs, own, `${path} must restore the offloaded inputs`);
  }
});

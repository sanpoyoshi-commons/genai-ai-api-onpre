import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * ナレッジ集の migration の読み取り検査。
 *
 * テストランナーは PostgreSQL を持たないので、流した結果ではなく**流す SQL の中身**を確かめる
 * （列の追加 → 既存行の移送 → NOT NULL 化 → 外部キーの順になっているか、移送が所有者ごとに 1 つの
 * ナレッジ集を作って全行を移すか）。実際に流すのは compose の migrate サービス。
 */

const MIGRATION = 'prisma/migrations/20261010000000_rag_knowledge_collections/migration.sql';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sql = readFileSync(`${repoRoot}${MIGRATION}`, 'utf8');
const at = (needle: string): number => {
  const index = sql.indexOf(needle);
  assert.notEqual(index, -1, `SQL に「${needle}」が無い`);
  return index;
};

test('migration が 1 本だけ足されている（prisma migrate deploy が拾う名前）', () => {
  const names = readdirSync(`${repoRoot}prisma/migrations`, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(names.includes('20261010000000_rag_knowledge_collections'));
  // 日付の順に並ぶ（prisma は名前順に流す）。
  assert.deepEqual([...names].sort(), names.slice().sort());
});

test('rag_collections を作り、所有者と名前の組を一意にする', () => {
  assert.ok(sql.includes('CREATE TABLE "rag_collections"'));
  assert.ok(sql.includes('"mcp_enabled" BOOLEAN NOT NULL DEFAULT false'));
  assert.ok(
    sql.includes('CREATE UNIQUE INDEX "rag_collections_owner_user_id_name_key" ON "rag_collections"("owner_user_id", "name")'),
  );
});

test('rag_source_documents に 3 層の列が足される', () => {
  for (const column of [
    'collection_id',
    'bronze_key',
    'sha256',
    'mime',
    'original_filename',
    'byte_size',
    'silver_text',
    'extractor',
    'extractor_version',
    'char_count',
    'status',
    'error',
  ]) {
    assert.ok(
      sql.includes(`ALTER TABLE "rag_source_documents" ADD COLUMN "${column}"`),
      `${column} の追加が無い`,
    );
  }
  // 取り込みの結果は既定で ready（既存行は作り直せないが、検索には出る）。
  assert.ok(sql.includes(`ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready'`));
});

test('rag_chunks に切り方の設定と埋め込みモデルが足される', () => {
  assert.ok(sql.includes('ALTER TABLE "rag_chunks" ADD COLUMN "chunker_config" JSONB'));
  assert.ok(sql.includes('ALTER TABLE "rag_chunks" ADD COLUMN "embedding_model" TEXT'));
});

test('既存の文書は所有者ごとの「未分類」へ移る（1 所有者に 1 つだけ作る）', () => {
  // 所有者ごとに 1 行だけ作る（GROUP BY）。同名が既にあれば作らない。
  assert.ok(sql.includes('INSERT INTO "rag_collections"'));
  assert.ok(sql.includes(`'未分類'`));
  assert.ok(sql.includes('GROUP BY d."owner_user_id"'));
  assert.ok(sql.includes('ON CONFLICT ("owner_user_id", "name") DO NOTHING'));
  // 移送は所有者が一致する「未分類」へ。まだ入っていない行だけを埋める。
  assert.ok(sql.includes('UPDATE "rag_source_documents" d'));
  assert.ok(sql.includes('c."owner_user_id" = d."owner_user_id"'));
  assert.ok(sql.includes('d."collection_id" IS NULL'));
});

test('列の追加 → 移送 → NOT NULL 化 → 外部キーの順になっている', () => {
  const added = at('ALTER TABLE "rag_source_documents" ADD COLUMN "collection_id" TEXT;');
  const backfilled = at('UPDATE "rag_source_documents" d');
  const notNull = at('ALTER COLUMN "collection_id" SET NOT NULL');
  const foreignKey = at('ADD CONSTRAINT "rag_source_documents_collection_id_fkey"');
  assert.ok(added < backfilled, '移送より先に列を足す');
  assert.ok(backfilled < notNull, 'NOT NULL 化より先に移送する');
  assert.ok(notNull < foreignKey, '外部キーは最後');
});

test('ナレッジ集を消すと中の文書も消える（外部キーの連鎖）', () => {
  assert.ok(
    sql.includes(
      'FOREIGN KEY ("collection_id") REFERENCES "rag_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    ),
  );
});

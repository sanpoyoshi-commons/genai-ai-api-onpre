-- ナレッジ集と、保存の 3 層（原本／抽出テキスト／チャンクと埋め込み）の列を足す。
--
-- 既存の文書は原本を持たない（画面が無かった時期に API だけで入ったため）。所有者ごとに
-- 「未分類」のナレッジ集を作ってそこへ移し、bronze_key と silver_text は空のまま残す
-- （原本が無いので作り直せない。画面がその旨を表示する）。
-- 列の追加 → 既存行の移送 → NOT NULL 化 → 外部キーの順で流す（途中で止まっても壊れた中間状態を残さない）。

-- CreateTable: rag_collections（ナレッジ集）
CREATE TABLE "rag_collections" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mcp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_collections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rag_collections_owner_user_id_idx" ON "rag_collections"("owner_user_id");
-- 同じ利用者の中で名前は一意（別の利用者が同じ名前を使うのは可）。
CREATE UNIQUE INDEX "rag_collections_owner_user_id_name_key" ON "rag_collections"("owner_user_id", "name");

-- AlterTable: rag_source_documents に 3 層の列を足す（collection_id は移送まで NULL 可）
ALTER TABLE "rag_source_documents" ADD COLUMN "collection_id" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "bronze_key" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "sha256" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "mime" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "original_filename" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "byte_size" INTEGER;
ALTER TABLE "rag_source_documents" ADD COLUMN "silver_text" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "extractor" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "extractor_version" TEXT;
ALTER TABLE "rag_source_documents" ADD COLUMN "char_count" INTEGER;
ALTER TABLE "rag_source_documents" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "rag_source_documents" ADD COLUMN "error" TEXT;

-- 既存文書の移送：所有者ごとに「未分類」のナレッジ集を 1 つ作る。
-- gen_random_uuid() は PostgreSQL 13 以降の組み込み（本スタックは 16）。
INSERT INTO "rag_collections" ("id", "owner_user_id", "name", "description")
SELECT gen_random_uuid()::text, d."owner_user_id", '未分類', '画面が無かった時期に API から入った文書の置き場。原本が無いため作り直せません。'
FROM "rag_source_documents" d
GROUP BY d."owner_user_id"
ON CONFLICT ("owner_user_id", "name") DO NOTHING;

UPDATE "rag_source_documents" d
SET "collection_id" = c."id"
FROM "rag_collections" c
WHERE c."owner_user_id" = d."owner_user_id" AND c."name" = '未分類' AND d."collection_id" IS NULL;

ALTER TABLE "rag_source_documents" ALTER COLUMN "collection_id" SET NOT NULL;

CREATE INDEX "rag_source_documents_collection_id_idx" ON "rag_source_documents"("collection_id");

-- AddForeignKey: ナレッジ集を消すと中の文書も消える（文書を消すとチャンクも消える＝既存の FK）
ALTER TABLE "rag_source_documents" ADD CONSTRAINT "rag_source_documents_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "rag_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: rag_chunks に「どの切り方・どの埋め込みモデルで作ったか」を足す
ALTER TABLE "rag_chunks" ADD COLUMN "chunker_config" JSONB;
ALTER TABLE "rag_chunks" ADD COLUMN "embedding_model" TEXT;

-- 法令 RAG（上流 lawsy-custom-bq を pgvector で再現）スキーマ。
-- 法令データは e-Gov 由来のグローバル公開データ（dump 配布予定）。owner_user_id を持たない。
-- 3 層：dwh_laws（全履歴・MERGE 先）→ app_laws_master（法令名照合）＋ app_laws_for_indexing（条文・本文検索）。
-- テーブル本体（本文・メタ）＋ pg_bigm GIN（embedding 不要で効く）まで。
-- embedding 列は NULL 許容で用意し、生成と vector index（HNSW or ivfflat はベンチ後）。
-- embedding は ruri 768 次元。PLaMo（2048）採用時は モデル別テーブルとして別 migration で追加予定

-- Extensions（pgvector / pg_bigm）。initdb は空ボリューム初回のみのため migration でも冪等有効化。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- CreateTable: dwh_laws（DWH 層・全履歴）
CREATE TABLE "dwh_laws" (
    "law_id" TEXT NOT NULL,
    "law_num" TEXT NOT NULL,
    "law_title" TEXT NOT NULL,
    "unique_anchor" TEXT NOT NULL,
    "anchor" TEXT,
    "content" TEXT NOT NULL,
    "article_summary" TEXT,
    "era" TEXT,
    "year" INTEGER,
    "law_type" TEXT,
    "promulgate_date" DATE,
    "load_timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dwh_laws_pkey" PRIMARY KEY ("law_id", "unique_anchor")
);

-- CreateTable: app_laws_master（App 層・法令マスタ＝law_num 最新版＋法令名 embedding）
CREATE TABLE "app_laws_master" (
    "law_num" TEXT NOT NULL,
    "law_title" TEXT NOT NULL,
    "promulgate_date" DATE,
    "law_title_embedding" vector(768),

    CONSTRAINT "app_laws_master_pkey" PRIMARY KEY ("law_num")
);

-- CreateTable: app_laws_for_indexing（App 層・条文インデックス＝本文ベクトル検索対象）
CREATE TABLE "app_laws_for_indexing" (
    "law_num" TEXT NOT NULL,
    "law_id" TEXT NOT NULL,
    "law_title" TEXT NOT NULL,
    "unique_anchor" TEXT NOT NULL,
    "anchor" TEXT,
    "content" TEXT NOT NULL,
    "article_summary" TEXT,
    "content_embedding" vector(768),

    CONSTRAINT "app_laws_for_indexing_pkey" PRIMARY KEY ("law_num", "unique_anchor")
);

-- CreateIndex: pg_bigm GIN（2-gram 全文検索・日本語）。条文本文の `=%`／LIKE 検索が使用。
-- embedding なしでも効くため作成。
CREATE INDEX "app_laws_for_indexing_content_bigm_idx"
    ON "app_laws_for_indexing" USING gin ("content" gin_bigm_ops);

-- NOTE: vector index は embedding 生成後に追加。
--   HNSW 例（既存一般 RAG 踏襲・lists 不要）：
--     CREATE INDEX "app_laws_master_title_emb_hnsw_idx"
--       ON "app_laws_master" USING hnsw ("law_title_embedding" vector_cosine_ops);
--     CREATE INDEX "app_laws_for_indexing_content_emb_hnsw_idx"
--       ON "app_laws_for_indexing" USING hnsw ("content_embedding" vector_cosine_ops);
--   ivfflat 例（lawsy 原典・num_lists 要調整。516,277 チャンク規模で HNSW と比較）：
--     CREATE INDEX ... USING ivfflat ("content_embedding" vector_cosine_ops) WITH (lists = ...);

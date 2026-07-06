-- RAG 格納・検索基盤。
-- pgvector + pg_bigm + RRF／モデル別テーブル（ruri 768 次元）／元文書テーブル。
-- 拡張は postgres カスタムイメージの initdb でも有効化されるが、既存ボリュームへの後付けにも耐えるよう
-- migration 側でも IF NOT EXISTS で冪等に有効化する（initdb は空ボリューム初回のみ実行のため）。

-- Extensions（pgvector / pg_bigm）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- CreateTable: rag_source_documents（元文書）
CREATE TABLE "rag_source_documents" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expire_at" TIMESTAMPTZ(6),

    CONSTRAINT "rag_source_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable: rag_chunks（チャンク本文＋embedding 同一行＝AWS Bedrock KB と同形）
CREATE TABLE "rag_chunks" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "header_path" TEXT,
    "embedding" vector(768),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 元文書スコープ／TTL
CREATE INDEX "rag_source_documents_owner_user_id_idx" ON "rag_source_documents"("owner_user_id");
CREATE INDEX "rag_source_documents_expire_at_idx" ON "rag_source_documents"("expire_at");

-- CreateIndex: チャンクの文書参照／検索スコープ
CREATE INDEX "rag_chunks_document_id_idx" ON "rag_chunks"("document_id");
CREATE INDEX "rag_chunks_owner_user_id_idx" ON "rag_chunks"("owner_user_id");

-- CreateIndex: pgvector HNSW（cosine）。空テーブルでも作成可・学習不要（ivfflat と違い lists 不要）。
-- 中小規模データ前提。大規模時はパラメータ調整が必要。
CREATE INDEX "rag_chunks_embedding_hnsw_idx" ON "rag_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- CreateIndex: pg_bigm GIN（2-gram 全文検索・日本語対応）。`=%` 演算子／LIKE がこのインデックスを使う。
CREATE INDEX "rag_chunks_chunk_text_bigm_idx" ON "rag_chunks" USING gin ("chunk_text" gin_bigm_ops);

-- AddForeignKey: チャンクは元文書削除でカスケード
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "rag_source_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

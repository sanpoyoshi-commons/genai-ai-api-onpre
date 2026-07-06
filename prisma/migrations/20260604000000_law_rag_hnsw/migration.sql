-- 法令 RAG: vector index（HNSW）を embedding 生成後に追加する。
-- 20260601000000_law_rag の NOTEで雛形として残していた DDL を実体化したもの。
--
-- 方式＝HNSW（仮置きを実機ベンチで確定）。
--   実機ベンチ（app_laws_for_indexing.content_embedding・n=30,536・ruri-768 int8・代表 15 クエリ・
--   正解=exact seqscan kNN）：
--     HNSW(default m=16/ef_construction=64, ef_search=40): Recall@10=92.0% / query 1.4ms / build 14.7s
--     ivfflat(lists=174, probes=10)                      : Recall@10=85.3% / query 1.9ms / build 1.8s
--   → Recall・レイテンシで HNSW 優位。build はやや長いが build-once-query-many で一回コスト。
--   既存一般 RAG（20260528000000_rag: rag_chunks_embedding_hnsw_idx）と同様、HNSW は学習不要・
--   lists 不要・空テーブルでも作成可。パラメータは pgvector 既定（m=16/ef_construction=64）。
--
-- 注：full content（255,680 行）充填後は本インデックスを全量で再構築する（規模で ef_search 等を再調整）。

-- CreateIndex: 法令名 embedding（法令名ベクトル検索）の意味検索。
CREATE INDEX IF NOT EXISTS "app_laws_master_title_emb_hnsw_idx"
    ON "app_laws_master" USING hnsw ("law_title_embedding" vector_cosine_ops);

-- CreateIndex: 条文本文 embedding（ハイブリッド検索の意味側）。pg_bigm GIN（全文）＋ RRF と併用。
CREATE INDEX IF NOT EXISTS "app_laws_for_indexing_content_emb_hnsw_idx"
    ON "app_laws_for_indexing" USING hnsw ("content_embedding" vector_cosine_ops);

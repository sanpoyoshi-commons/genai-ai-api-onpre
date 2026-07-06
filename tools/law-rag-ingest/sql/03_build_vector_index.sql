-- App 層 embedding 列（vector(768)）に HNSW vector index を全量構築する（法令 RAG）。
--
-- 由来（attribution）:
--   Derived from Digital Agency of Japan's `lawsy-custom-bq/preprocess/sql` の
--   ステップ3（CREATE VECTOR INDEX）に相当（MIT License, Copyright (c) 2026 Digital Agency of Japan）。
--
-- 上流との差分（明示）:
--   - 上流 BQML の `CREATE VECTOR INDEX ... OPTIONS(index_type='IVF', ...)` を pgvector の HNSW へ置換。
--     HNSW は lists 不要・既存一般 RAG 踏襲（取り込み段で「HNSW 仮置き」と確定。ivfflat との 516k ベンチは別タスク）。
--   - 距離関数は cosine（retrieve 側 RagService と一致＝vector_cosine_ops）。
--
-- 前提（重要）:
--   - embedding 充填（embed_fill.py --target both）が完了していること。
--     HNSW は「データ投入後にまとめて構築」が定石（空テーブルに張ってから充填すると低速）。
--   - 本 SQL は明示的な「全量再構築」。既存 index があれば一旦 DROP してから張り直す（冪等）。
--   - 単一トランザクション・CONCURRENTLY 不使用（配布元ビルド時ツール＝同時書き込みなし＝plain が高速）。

-- 構築メモリ。HNSW グラフが maintenance_work_mem に収まらないと on-disk フォールバックで低速化する。
-- RAM 12GB 機では tei 常駐と競合しうるため控えめな既定。潤沢な環境では起動前に SET で引き上げ可
-- （例: SET maintenance_work_mem = '2GB';）。content 25.6 万行規模はここが構築時間の主レバー。
SET maintenance_work_mem = '1GB';
-- 並列構築は無効化（直列）。pgvector の並列 HNSW 構築は maintenance_work_mem 相当の共有メモリ
-- セグメント(DSM)を /dev/shm に確保するが、Docker コンテナの /dev/shm は既定 64MB しかなく
-- "could not resize shared memory segment … No space left on device" で落ちる。配布元 1 回の
-- build なので速度より確実性を優先し直列で張る（DSM 不使用・maintenance_work_mem はバックエンド
-- ローカルメモリで完結）。並列で速くしたい場合は postgres を shm_size: 1g 以上で起動して 2 に戻す。
SET max_parallel_maintenance_workers = 0;

-- 法令マスタ（law_title_embedding・7,813 行規模・法令名ベクトル検索）。
DROP INDEX IF EXISTS app_laws_master_title_emb_hnsw_idx;
CREATE INDEX app_laws_master_title_emb_hnsw_idx
    ON app_laws_master USING hnsw (law_title_embedding vector_cosine_ops);

-- 条文インデックス（content_embedding・255,680 行規模・本文ベクトル検索）。
DROP INDEX IF EXISTS app_laws_for_indexing_content_emb_hnsw_idx;
CREATE INDEX app_laws_for_indexing_content_emb_hnsw_idx
    ON app_laws_for_indexing USING hnsw (content_embedding vector_cosine_ops);

-- プランナ統計を更新（index 構築直後の最適化）。
ANALYZE app_laws_master;
ANALYZE app_laws_for_indexing;

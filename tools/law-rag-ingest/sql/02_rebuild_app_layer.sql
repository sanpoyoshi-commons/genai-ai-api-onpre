-- App 層 app_laws_master / app_laws_for_indexing を DWH 層 dwh_laws から再構築する。
--
-- 由来（attribution）:
--   Derived from Digital Agency of Japan's `lawsy-custom-bq/preprocess/sql/02_rebuild_app_layer.sql`
--   (MIT License, Copyright (c) 2026 Digital Agency of Japan).
--
-- 上流との差分（明示）:
--   - 上流は CREATE OR REPLACE TABLE で作り直すが、本リポは Prisma migration でテーブルと
--     embedding 列・index を管理するため TRUNCATE + INSERT で中身だけ入れ替える。
--   - 上流ステップ1（app_laws_master）は ML.GENERATE_EMBEDDING で law_title_embedding を同時生成
--     するが、embedding 生成は後段へ送り、ここでは embedding 列を NULL のまま入れる。
--   - master は DENSE_RANK rnk=1 + SELECT DISTINCT 相当を DISTINCT ON (law_num) に置換。
--     law_num が PK のため最新版を 1 行に確定する必要があり、同点時は law_title で決定的に採る。
--   - 上流ステップ3（CREATE VECTOR INDEX / IVF）は後段（HNSW 仮置き・ivfflat はベンチ後）。

-- ステップ1: 法令マスタ app_laws_master（law_num ごと最新版の法令名）。
TRUNCATE app_laws_master;
INSERT INTO app_laws_master (law_num, law_title, promulgate_date)
SELECT DISTINCT ON (law_num)
  law_num, law_title, promulgate_date
FROM dwh_laws
ORDER BY law_num, promulgate_date DESC NULLS LAST, load_timestamp DESC, law_title;
-- law_title_embedding は NULL のまま（後段で生成）。

-- ステップ2: 条文インデックス app_laws_for_indexing（law_num+unique_anchor ごと最新版）。
TRUNCATE app_laws_for_indexing;
INSERT INTO app_laws_for_indexing (
  law_num, law_id, law_title, unique_anchor, anchor, content, article_summary
)
SELECT
  law_num, law_id, law_title, unique_anchor, anchor, content, article_summary
FROM (
  SELECT
    law_num, law_id, law_title, unique_anchor, anchor, content, article_summary,
    ROW_NUMBER() OVER (
      PARTITION BY law_num, unique_anchor
      ORDER BY promulgate_date DESC NULLS LAST, law_id DESC
    ) AS rn
  FROM dwh_laws
) ranked
WHERE rn = 1
  -- 削除 stub（本文が「削除」だけの範囲/単条削除条文）は検索ノイズなので App 層に入れない（所見 B・
  -- 防御的二重化＝取り込み側 xml_to_jsonl.is_deletion_stub と同条件）。先頭（タイトル）行を除いた本文を
  -- trim して「削除」だけの行を除外。本文に「削除」を含むだけの正当条文は全体一致しないため保持される。
  AND btrim(regexp_replace(content, '^[^' || E'\n' || ']*' || E'\n', ''), E' 　\n\t') <> '削除';
-- content_embedding は NULL のまま（後段で生成）。

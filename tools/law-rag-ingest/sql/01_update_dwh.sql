-- DWH 層 dwh_laws を更新する。取り込みバッチのステージング（_law_ingest_staging）を
-- (law_id, unique_anchor) で MERGE し、条文ごとの一意性を担保する。
--
-- 由来（attribution）:
--   Derived from Digital Agency of Japan's `lawsy-custom-bq/preprocess/sql/01_update_dwh.sql`
--   (MIT License, Copyright (c) 2026 Digital Agency of Japan).
--   BigQuery MERGE を PostgreSQL 16 の MERGE へ移植。`{source_table}` は同一バッチの
--   TEMP ステージング表に置換。意味（content 差分時のみ UPDATE＋load_timestamp 更新）は不変。
--
-- 上流との差分（PG 側の堅牢化・三分離の「推測」ではなく明示）:
--   USING を DISTINCT ON で重複除去する。MERGE は 1 ターゲット行を二度更新できず、
--   万一同一バッチに (law_id, unique_anchor) 重複があるとエラーになるため、最後の 1 行を採る。

MERGE INTO dwh_laws AS t
USING (
  SELECT DISTINCT ON (law_id, unique_anchor)
    law_id, law_num, law_title, unique_anchor, anchor, content, article_summary,
    era, year, law_type, promulgate_date
  FROM _law_ingest_staging
  ORDER BY law_id, unique_anchor
) AS s
ON t.law_id = s.law_id AND t.unique_anchor = s.unique_anchor
WHEN MATCHED AND t.content <> s.content THEN
  UPDATE SET
    law_num = s.law_num,
    law_title = s.law_title,
    anchor = s.anchor,
    content = s.content,
    article_summary = s.article_summary,
    era = s.era,
    year = s.year,
    law_type = s.law_type,
    promulgate_date = s.promulgate_date,
    load_timestamp = CURRENT_TIMESTAMP
WHEN NOT MATCHED THEN
  INSERT (
    law_id, law_num, law_title, unique_anchor, anchor, content, article_summary,
    era, year, law_type, promulgate_date, load_timestamp
  )
  VALUES (
    s.law_id, s.law_num, s.law_title, s.unique_anchor, s.anchor, s.content,
    s.article_summary, s.era, s.year, s.law_type, s.promulgate_date, CURRENT_TIMESTAMP
  );

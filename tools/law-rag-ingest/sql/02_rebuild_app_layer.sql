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
--     （法令名は版間でほぼ不変なので施行日フィルタは不要。時間軸の対象は条文インデックス側。）
--   - 版選別（app_laws_for_indexing）は上流と意図的に異なる。上流は
--     ORDER BY promulgate_date DESC, law_id DESC の rn=1 で「最も新しい版」を採るが、
--     e-Gov 一括データは 1 法令を施行日ごとの複数版（law_id=「法令ID_施行日_改正法ID」）で持ち、
--     promulgate_date は版間で不変（＝tie）なので実質 law_id DESC が効き、結果として
--     「最も未来の施行日＝未施行版」の本文を採る。本リポは現行施行版を返すため
--     「施行日 ≤ 今日(JST) の版のうち施行日最新」に限定する（施行日は law_id の中間フィールド）。
--     施行日が今日以前の版を持たない条文（将来改正で新設される条文）は現行法ではないので
--     索引に入れない（将来的に施行日/未施行フラグを持たせ as-of で時点解決する想定）。
--   - 上流ステップ3（CREATE VECTOR INDEX / IVF）は後段（HNSW 仮置き・ivfflat はベンチ後）。

-- ステップ1: 法令マスタ app_laws_master（law_num ごと最新版の法令名）。
TRUNCATE app_laws_master;
INSERT INTO app_laws_master (law_num, law_title, promulgate_date)
SELECT DISTINCT ON (law_num)
  law_num, law_title, promulgate_date
FROM dwh_laws
ORDER BY law_num, promulgate_date DESC NULLS LAST, load_timestamp DESC, law_title;
-- law_title_embedding は NULL のまま（後段で生成）。

-- ステップ2: 条文インデックス app_laws_for_indexing（施行日≤今日(JST) のうち施行日最新＝現行施行版）。
--   施行日 = law_id の中間フィールド（law_id は「法令ID_YYYYMMDD施行日_改正法ID」の 3 部構成）。
--   現行施行版に限定する理由・上流との差異はファイル冒頭「上流との差分」を参照。
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
      ORDER BY to_date(split_part(law_id, '_', 2), 'YYYYMMDD') DESC, law_id DESC
    ) AS rn
  FROM dwh_laws
  -- 現行施行版のみを候補にする（施行日 ≤ 今日 JST）。施行日フィールドが 8 桁数字でない想定外の
  -- law_id は to_date 失敗を避けるため除外（防御的・現データは 100% 準拠を実測）。JST 明示は
  -- postgres の TimeZone が UTC のため（素の CURRENT_DATE では日付境界が UTC 判定になる）。
  WHERE split_part(law_id, '_', 2) ~ '^[0-9]{8}$'
    AND to_date(split_part(law_id, '_', 2), 'YYYYMMDD') <= (now() AT TIME ZONE 'Asia/Tokyo')::date
) ranked
WHERE rn = 1
  -- 削除 stub（本文が「削除」だけの範囲/単条削除条文）は検索ノイズなので App 層に入れない（所見 B・
  -- 防御的二重化＝取り込み側 xml_to_jsonl.is_deletion_stub と同条件）。先頭（タイトル）行を除いた本文を
  -- trim して「削除」だけの行を除外。本文に「削除」を含むだけの正当条文は全体一致しないため保持される。
  AND btrim(regexp_replace(content, '^[^' || E'\n' || ']*' || E'\n', ''), E' 　\n\t') <> '削除';
-- content_embedding は NULL のまま（後段で生成）。

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
--     「最も未来の施行日＝未施行版」の本文を採る。本リポは現行施行版を優先するため
--     「施行日 ≤ 今日(JST) の版があればそのうち施行日最新（現行施行版・is_future=false）」を採る。
--   - as-of 対応：施行日が今日以前の版を持たない条文（将来改正で新設される条文）も、
--     将来版のうち施行日最早を代表として **is_future=true** で索引に追加する（意味検索で位置特定
--     できるように embedding 対象へ入れる）。既定モードは retrieve 側で WHERE is_future=false により
--     除外する（無印で現行索引に混ぜると「未施行本文採用」の元欠陥の縮小再生産になるため）。
--     施行日(enforce_date)は 01_update_dwh.sql が law_id から実カラム化済み。
--   - 上流ステップ3（CREATE VECTOR INDEX / IVF）は後段（HNSW 仮置き・ivfflat はベンチ後）。

-- ステップ1: 法令マスタ app_laws_master（law_num ごと最新版の法令名）。
TRUNCATE app_laws_master;
INSERT INTO app_laws_master (law_num, law_title, promulgate_date)
SELECT DISTINCT ON (law_num)
  law_num, law_title, promulgate_date
FROM dwh_laws
ORDER BY law_num, promulgate_date DESC NULLS LAST, load_timestamp DESC, law_title;
-- law_title_embedding は NULL のまま（後段で生成）。

-- ステップ2: 条文インデックス app_laws_for_indexing（現行施行版＝is_future=false／将来のみ新設＝is_future=true）。
--   施行日 enforce_date = law_id の中間フィールド YYYYMMDD の実カラム化（01_update_dwh.sql が充填）。
--   条文（law_num, unique_anchor）ごとに 1 版だけ索引する：
--     ・現行版（enforce_date ≤ 今日 JST）があれば、そのうち施行日最新を採り is_future=false。
--     ・現行版が無い（将来改正で新設される）条文は、将来版のうち施行日最早を代表に採り is_future=true。
--   選別理由・上流との差異はファイル冒頭「上流との差分」を参照。JST 明示は postgres の TimeZone が
--   UTC のため（素の CURRENT_DATE では日付境界が UTC 判定になる）。
TRUNCATE app_laws_for_indexing;
INSERT INTO app_laws_for_indexing (
  law_num, law_id, law_title, unique_anchor, anchor, content, article_summary, is_future
)
SELECT
  law_num, law_id, law_title, unique_anchor, anchor, content, article_summary, is_future
FROM (
  SELECT
    law_num, law_id, law_title, unique_anchor, anchor, content, article_summary,
    (enforce_date > (now() AT TIME ZONE 'Asia/Tokyo')::date) AS is_future,
    ROW_NUMBER() OVER (
      PARTITION BY law_num, unique_anchor
      ORDER BY
        -- 現行版（施行日≤今日）を最優先。現行がある条文はその中で施行日最新、
        -- 現行が無い条文（将来のみ新設）は将来版の中で施行日最早を代表に採る。
        (enforce_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date) DESC,
        CASE WHEN enforce_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date THEN enforce_date END DESC NULLS LAST,
        CASE WHEN enforce_date >  (now() AT TIME ZONE 'Asia/Tokyo')::date THEN enforce_date END ASC  NULLS LAST,
        law_id DESC
    ) AS rn
  FROM dwh_laws
  -- 施行日不明（想定外 law_id で 8 桁数字でない＝enforce_date が NULL）は索引に入れない
  -- （従来の to_date 失敗除外と同義・防御的）。
  WHERE enforce_date IS NOT NULL
) ranked
WHERE rn = 1
  -- 削除 stub（本文が「削除」だけの範囲/単条削除条文）は検索ノイズなので App 層に入れない（所見 B・
  -- 防御的二重化＝取り込み側 xml_to_jsonl.is_deletion_stub と同条件）。先頭（タイトル）行を除いた本文を
  -- trim して「削除」だけの行を除外。本文に「削除」を含むだけの正当条文は全体一致しないため保持される。
  AND btrim(regexp_replace(content, '^[^' || E'\n' || ']*' || E'\n', ''), E' 　\n\t') <> '削除';
-- content_embedding は NULL のまま（後段で生成）。is_future の付与で既定モード（WHERE is_future=false）は
-- as-of 導入前と同一の現行版集合になる（後方互換）。

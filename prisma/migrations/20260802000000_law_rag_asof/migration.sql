-- 法令 RAG 時間軸 as-of（データ層スキーマ）。
-- 方針＝既存テーブルへの列追加のみ（版テーブルは新設しない）。
--   ・dwh_laws に施行日を実カラム化（enforce_date＝law_id 中間フィールド）＋ as-of 版解決用 index。
--   ・app_laws_for_indexing に未施行フラグ（is_future）。既定モードは WHERE is_future=false で除外。
--   ・law_rag_meta（単一行）＝データ基準日（e-Gov 取得日）／リリースタグを dump 同梱し、
--     レポート出典セクションへ焼き込む（システムの知識時点を明示＝二時間軸の分離）。
-- 上流写像：BQ 側も preprocess SQL で enforce_date を列化し future 条文へ flag、retrieve に as_of
--   パラメータを足せば同形で対応できる（本リポは PostgreSQL 移植）。

-- dwh_laws: 施行日の実カラム化。law_id は「法令ID_YYYYMMDD施行日_改正法ID」の 3 部構成。
--   施行日フィールドが 8 桁数字でない想定外 law_id は NULL（防御的・現データは 100% 準拠を実測）。
--   to_date は STABLE のため GENERATED 列には使えない → plain 列＋backfill、以後の取り込みは
--   01_update_dwh.sql の INSERT が同式で充填する（scratch/差分ビルドと整合）。
ALTER TABLE "dwh_laws" ADD COLUMN "enforce_date" DATE;

UPDATE "dwh_laws"
SET "enforce_date" = CASE
    WHEN split_part("law_id", '_', 2) ~ '^[0-9]{8}$'
    THEN to_date(split_part("law_id", '_', 2), 'YYYYMMDD')
    ELSE NULL
  END
WHERE "enforce_date" IS NULL;

-- as-of 版解決用 index：(law_num, unique_anchor) で条文を束ね、施行日順に版を引く。
CREATE INDEX "dwh_laws_article_enforce_idx"
    ON "dwh_laws" ("law_num", "unique_anchor", "enforce_date");

-- app_laws_for_indexing: 未施行フラグ。現行施行版=false、将来のみ新設条文=true。
--   既定モードは WHERE is_future=false で除外（無印で現行索引に混ぜると元欠陥の縮小再生産になる）。
ALTER TABLE "app_laws_for_indexing"
    ADD COLUMN "is_future" BOOLEAN NOT NULL DEFAULT false;

-- law_rag_meta: データ基準日（知識時点）＝ dump 同梱で「データと表示が食い違わない」を担保。
--   単一行運用（id=1 固定・CHECK で単一行を強制）。api 起動時に 1 度だけ読みプロセス内キャッシュ。
CREATE TABLE "law_rag_meta" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "egov_fetch_date" DATE NOT NULL,
    "release_tag" TEXT NOT NULL,
    "built_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "law_rag_meta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "law_rag_meta_single_row" CHECK ("id" = 1)
);

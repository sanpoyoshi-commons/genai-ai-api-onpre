# law-rag-ingest

法令 RAG のデータ取り込みパイプライン。e-Gov 法令標準 XML を
条（Article）単位のチャンクへ分解し、PostgreSQL 投入用の JSONL（1 行 1 チャンク・11 カラム）に変換する。

このツールは **配布元（dump ビルド側）専用のビルド時ツール**であり、利用者環境の `docker compose up`
には同梱しない。利用者は事前ビルド済み DB dump を投入するだけで法令 RAG を利用できる
（全件ループ取得・法令 API v2 は使わない設計。2 回目以降の更新は全量 zip を取り直して
変化した条文だけ再 embedding する「差分ビルド」で行う → 「[差分ビルド](#差分ビルド2-回目以降の-dump-更新embedding-温存)」節）。

## データフロー

```
e-Gov 法令データ一括ダウンロード zip (約278MB)
  → bulk_download.py       … zip 取得 + XML 展開（配布元 1 回のみ）
  → <dest>/**/*.xml
  → xml_to_jsonl.py        … 条単位チャンク化
  → data.jsonl (11 カラム)
  → load_to_db.py          … TEMP staging へ COPY → dwh_laws へ MERGE → App 層再構築
  → app_laws_master / app_laws_for_indexing （embedding 列は NULL）
  → embed_fill.py          … NULL embedding を TEI/ruri-768 で全量充填（再開可能）
  → sql/03_build_vector_index.sql … HNSW vector index を全量再構築
  → DB dump 出力（配布物）
```

DB 投入は 3 層構造（Source(TEMP) → DWH `dwh_laws` → App `app_laws_master` /
`app_laws_for_indexing`）。SQL は `sql/01_update_dwh.sql`（MERGE）/ `sql/02_rebuild_app_layer.sql`
（App 層 TRUNCATE+INSERT 再構築）。テーブルと embedding 列・index は Prisma
（`prisma/migrations/20260601000000_law_rag/`）が管理する。embedding 生成と vector index は後段で行う。

11 カラム: `law_id, law_num, law_title, unique_anchor, anchor, content, article_summary,
era, year, law_type, promulgate_date`

## 使い方

```bash
# 0) e-Gov 一括 zip を取得し XML を展開（配布元で 1 回のみ。URL は要確認・下記注記）
python3 bulk_download.py --url <e-Gov bulk zip URL> --dest egov_xml

# 1) <source_dir> 配下の *.xml を再帰処理し JSONL を標準出力へ
python3 xml_to_jsonl.py <source_dir>

# ファイル出力・並列度指定
python3 xml_to_jsonl.py <source_dir> -o data.jsonl -j 8

# 2) JSONL を PostgreSQL の法令 RAG 3 層へ投入（psycopg v3 が必要）
python3 load_to_db.py data.jsonl --dsn postgresql://user:pass@host:5432/db

# パイプ直結（中間ファイルなし）
python3 xml_to_jsonl.py <source_dir> | python3 load_to_db.py - --dsn postgresql://…
# --dsn 省略時は libpq 環境変数（PGHOST / PGUSER / PGPASSWORD / PGDATABASE …）を使う
```

> 投入先テーブルは事前に Prisma migration（`20260601000000_law_rag`）で作成しておくこと。
> `load_to_db.py` は 1 バッチを 1 トランザクションで投入し、`dwh_laws` を MERGE（content 差分時のみ
> 更新）した後に App 層 2 表を再構築する。embedding 列は NULL のまま（後段で生成）。

> **【要確認】bulk_download.py の `--url`**：全件 zip への直接 URL は e-Gov 側更新で変わりうるため
> 本ツールに固定値を持たせていない（推測 URL を埋め込まない方針）。実行時に
> <https://laws.e-gov.go.jp/bulkdownload/> で現行 URL を確認して `--url` に渡すこと。
> 配布元での 1 回取得のみを想定（利用者環境では実行しない・法令 API の全件ループ取得もしない）。

## embedding 全量充填 → HNSW 全量再構築

取り込みで投入した App 層 2 表の embedding 列（`content_embedding` / `law_title_embedding`、ともに
`vector(768)`・NULL）を TEI/ruri-768 で埋め、完了後に HNSW vector index を張る工程。
**長時間（概算 47h 規模）をシェルで回す**ため、一括オーケストレータ `run_m2_fill.sh`
を用意した。`docker compose`（deploy リポ）と本ツールの両方を横断する。

```bash
# 推奨: nohup 放置（postgres+tei 起動 → 全量充填 → HNSW 再構築 → 検証）
cd ~/work/genai-ai-api-onpre/tools/law-rag-ingest
nohup ./run_m2_fill.sh > /dev/null 2>&1 &
# 進捗は起動時に表示される .law-build/m2-embed-fill.<時刻>.log を tail -f で追う

./run_m2_fill.sh --fill-only      # 充填のみ（index は後で）
./run_m2_fill.sh --index-only     # HNSW 構築のみ（充填が別途完了済のとき）
```

設計上の要点:

- **再開可能**：`embed_fill.py` は embedding が NULL の行だけを埋める。中断・OOM・再起動後に
  `run_m2_fill.sh` を再実行すれば残りだけ続行する（冪等）。
- **secret 非露出**：`postgres_password` の値はホスト/ログに出さず、使い捨て充填コンテナ・postgres
  コンテナの中で `cat /run/secrets/postgres_password` して libpq に渡す（取り込みと同方式）。
- **モデル一致**：充填と retrieve は同一 TEI（compose 既定 `ruri-v3-310m-onnx-int8`・768 次元）を叩く。
  retrieve 側 `EMBEDDING_MODEL_PATH` を変えたら**本充填と HNSW をやり直す**こと。
- **HNSW は充填後にまとめて構築**（`sql/03_build_vector_index.sql`・cosine）。空表に張ってから埋める
  と低速。RAM 12GB 機では充填中に 7B 級 LLM を同時起動しない（OOM）。

> 単体テストは `embed_fill.py` の純関数（pgvector 整形・バッチ分割・TEI ペイロード・adaptive 分割）まで。
> DB/TEI を伴う `fill_target()` の実投入と HNSW 構築は配布元環境（PostgreSQL 16 + pgvector + TEI）で実機確認する。

## 差分ビルド（2 回目以降の dump 更新・embedding 温存）

新しい all_xml で素朴に `load_to_db.py` を再実行すると、App 層再構築（`sql/02_rebuild_app_layer.sql`）が
TRUNCATE + INSERT（embedding 列 NULL）のため**充填済み embedding がすべて消え、全量充填（約 47h）を
やり直す**ことになる。embedding は「同一モデル × 同一テキスト → 同一ベクトル」の決定的な関数なので、
**テキストの md5 をキーに退避 → 再構築後に復元**すれば、NULL のまま残るのは**新規・改正で本文が変わった
条文だけ**になり、`embed_fill.py`（NULL の行だけ充填する再開可能設計）がそのまま差分充填として機能する。

**正しさの基準**：差分ビルドの最終状態は、同じ all_xml からのスクラッチ全量ビルドと一致すること
（`dwh_laws.load_timestamp` の値を除く）。これを満たすには、新 all_xml に存在しない
(law_id, unique_anchor) を dwh から削除する工程（下記 D-3）が必須。`sql/01_update_dwh.sql` の MERGE は
**追加と更新のみで削除を行わない**ため、D-3 を省くと廃止・削除された法令/条文が残留し、
スクラッチビルドと乖離する（検索ノイズにもなる）。

### 前提（すべて満たすこと）

- 既存 DB に前回取得分の embedding が充填済み（配布 dump を import した状態でも可）。
- **TEI の embedding モデルを前回充填時から変えていない**（compose の `EMBEDDING_MODEL_PATH`）。
  モデルを変えた場合は復元不可＝全量再充填（47h）一択。
- 新しい all_xml から `data.jsonl` 生成済み（`build_jsonl.sh` ／ `xml_to_jsonl.py`）。
- 事前に DB バックアップ（deploy `scripts/backup.sh`）推奨。退避テーブルは UNLOGGED
  （クラッシュで消える作業テーブル）＝安全網はバックアップ側。
- ディスク空きの目安 +1GB（退避テーブル ≈ 768 次元 × 4byte × 25 万行 ≈ 800MB）。
- 作業中（D-4 の TRUNCATE から D-6 完了まで）は法令 RAG 検索が空振り/劣化する。
  メンテナンス時間帯に実施し、重い LLM 常駐との同時実行は避ける（RAM）。

### 手順

変数・ヘルパ（deploy リポジトリ直下で。`scripts/law-rag-export.sh` と同じ接続流儀）:

```bash
cd ~/work/genai-deploy-onpre
dc()    { docker compose -f docker-compose.yml -f docker-compose.secrets.yml "$@"; }
PGU="$(dc exec -T postgres printenv POSTGRES_USER | tr -d '\r\n')"
PGD="$(dc exec -T postgres printenv POSTGRES_DB   | tr -d '\r\n')"
psqlx() { dc exec -T postgres psql -U "$PGU" -d "$PGD" -v ON_ERROR_STOP=1 "$@"; }
```

**D-1. embedding を md5(テキスト) キーで退避**（law_id・anchor でなくテキスト自体をキーにする。
改正で law_id や条番号が変わっても本文が同一なら流用でき、スクラッチビルドと同値になる）:

```bash
psqlx <<'SQL'
CREATE UNLOGGED TABLE _law_emb_keep_content AS
  SELECT DISTINCT ON (md5(content)) md5(content) AS content_md5, content_embedding
  FROM app_laws_for_indexing
  WHERE content_embedding IS NOT NULL
  ORDER BY md5(content);
CREATE INDEX ON _law_emb_keep_content (content_md5);

CREATE UNLOGGED TABLE _law_emb_keep_title AS
  SELECT DISTINCT ON (md5(law_title)) md5(law_title) AS title_md5, law_title_embedding
  FROM app_laws_master
  WHERE law_title_embedding IS NOT NULL
  ORDER BY md5(law_title);
CREATE INDEX ON _law_emb_keep_title (title_md5);
SQL
```

**D-2. 新 all_xml のキー集合を投入**（D-3 の削除判定に使う）:

```bash
python3 - ".law-build/data.jsonl" > /tmp/law_keys_new.tsv <<'PY'
import json, sys
seen = set()
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        k = (r["law_id"], r["unique_anchor"])
        if k not in seen:
            seen.add(k)
            print(*k, sep="\t")
PY
psqlx -c "CREATE UNLOGGED TABLE _law_keys_new (law_id text NOT NULL, unique_anchor text NOT NULL);"
psqlx -c "\copy _law_keys_new FROM STDIN" < /tmp/law_keys_new.tsv
psqlx -c "CREATE INDEX ON _law_keys_new (law_id, unique_anchor);"
```

**D-3. 廃止・削除分を dwh から先に掃除**（MERGE は削除しないため。件数が想定外に大きい場合＝
数十万規模なら data.jsonl 生成ミスを疑い、ここで中断して原因を確認する）:

```bash
# （Release notes 素材）削除対象の法令別内訳を先に記録する。DELETE 後は復元できないため、
# 取るならこのタイミングが唯一。
psqlx -tA -F'	' <<'SQL' > ~/work/genai-deploy-onpre/.law-build/deleted-report-$(date +%Y%m%d).tsv
SELECT d.law_title, d.law_num, count(*) AS deleted_rows
  FROM dwh_laws d
 WHERE NOT EXISTS (SELECT 1 FROM _law_keys_new k
                   WHERE k.law_id = d.law_id AND k.unique_anchor = d.unique_anchor)
 GROUP BY d.law_title, d.law_num
 ORDER BY deleted_rows DESC, d.law_title;
SQL

psqlx -c "DELETE FROM dwh_laws d
          WHERE NOT EXISTS (SELECT 1 FROM _law_keys_new k
                            WHERE k.law_id = d.law_id AND k.unique_anchor = d.unique_anchor);"
```

**D-4. 通常どおり取り込み**（TEMP staging → dwh MERGE → App 層再構築。ここで App 層の embedding が
いったん全 NULL になる）。実行方式は全量ビルド時と同じ（psycopg・secret はコンテナ内で解決）:

```bash
python3 load_to_db.py ~/work/genai-deploy-onpre/.law-build/data.jsonl --dsn postgresql://…
```

**D-5. HNSW を外してから embedding を復元**（HNSW を残したまま 25 万行 UPDATE すると index の
逐次維持で大幅に遅くなる。どうせ D-6 の `03_build_vector_index.sql` が DROP → 全量再構築する）:

```bash
psqlx <<'SQL'
DROP INDEX IF EXISTS app_laws_for_indexing_content_emb_hnsw_idx;
DROP INDEX IF EXISTS app_laws_master_title_emb_hnsw_idx;

UPDATE app_laws_for_indexing a
SET content_embedding = k.content_embedding
FROM _law_emb_keep_content k
WHERE a.content_embedding IS NULL AND md5(a.content) = k.content_md5;

UPDATE app_laws_master m
SET law_title_embedding = k.law_title_embedding
FROM _law_emb_keep_title k
WHERE m.law_title_embedding IS NULL AND md5(m.law_title) = k.title_md5;

-- 残った NULL ＝ 今回 embedding し直す差分量。所要時間の見積り ≈ 47h × (残行数 ÷ 全行数)
SELECT 'content' AS target, count(*) AS to_embed
  FROM app_laws_for_indexing WHERE content_embedding IS NULL AND content <> ''
UNION ALL
SELECT 'title', count(*)
  FROM app_laws_master WHERE law_title_embedding IS NULL AND law_title <> '';
SQL
```

**D-6. 差分充填 → HNSW 全量再構築**（既存オーケストレータをそのまま使う。`embed_fill.py` は
NULL の行しか触らないので、これが差分充填になる）:

```bash
cd ~/work/genai-ai-api-onpre/tools/law-rag-ingest
nohup ./run_m2_fill.sh > /dev/null 2>&1 &   # 充填 → 03_build_vector_index.sql まで一括
```

**D-7. 検証 → 作業テーブル掃除 → export**:

```bash
# NULL 残ゼロ（充填対象条件を満たす行）を確認
psqlx -c "SELECT count(*) FROM app_laws_for_indexing WHERE content_embedding IS NULL AND content <> '';"
psqlx -c "SELECT count(*) FROM app_laws_master       WHERE law_title_embedding IS NULL AND law_title <> '';"

# retrieve 疎通（任意・メンテナ環境のベンチ用ハーネスで smoke 確認）

# （Release notes 素材）再 embedding された条文＝「本文が旧データのどの条文とも一致しない行」の
# 法令別内訳。_law_emb_keep_content を使うため、作業テーブル掃除の前が唯一の機会。
# ※新規制定と改正の区別はつかない（テキスト差分ベースのため）。削除分の内訳は D-3 で記録済み。
psqlx -tA -F'	' <<'SQL' > ~/work/genai-deploy-onpre/.law-build/diff-report-$(date +%Y%m%d).tsv
SELECT a.law_title, a.law_num, count(*) AS changed_articles
  FROM app_laws_for_indexing a
 WHERE NOT EXISTS (SELECT 1 FROM _law_emb_keep_content k WHERE k.content_md5 = md5(a.content))
 GROUP BY a.law_title, a.law_num
 ORDER BY changed_articles DESC, a.law_title;
SQL

# 作業テーブルを掃除
psqlx -c "DROP TABLE IF EXISTS _law_emb_keep_content, _law_emb_keep_title, _law_keys_new;"

# 配布 dump を生成（作業テーブルは -t 指定外なので dump には入らない）
cd ~/work/genai-deploy-onpre && ./scripts/law-rag-export.sh
```

Release タグは配布日で `law-rag-<YYYYMMDD>`（アセット名は `law-rag.dump` にリネーム）
＝ `scripts/law-rag-export.sh` ヘッダの命名規約どおり。データ基準日（e-Gov 取得日）はタグとは
別で、dump 同梱の `law_rag_meta` が正。D-3／D-7 で記録した法令別内訳
（deleted-report／diff-report）は Release notes の差分内訳に使い、あわせて deploy リポの
`CHANGELOG.md` に dump 更新エントリ（1 行サマリ＋Release notes へのリンク）を追加する。

### 制約・注意

- **モデル変更時は差分ビルド不可**：`EMBEDDING_MODEL_PATH` を変えたら全 embedding が旧モデル由来に
  なるため、退避・復元せず全量充填をやり直す（「モデル一致」の項と同じ制約）。
- **`dwh_laws.load_timestamp` はスクラッチビルドと一致しない**（差分ビルドでは既存行の値を引き継ぐ）。
  検索・配布品質には影響しない。
- 退避テーブルは UNLOGGED＝postgres がクラッシュすると消える。D-4 以降にそれが起きたら
  事前バックアップから戻してやり直す。
- D-5 の復元 UPDATE は index なしなら数分規模。D-4〜D-6 の間は法令 RAG 検索が実質使えない。

## 時間軸 as-of（データ／API 層）

法令データは e-Gov の時点断面で、1 条文が施行日ごとに複数版を持つ（`dwh_laws` は全版保持）。App 層の索引は
「探す（意味検索）」専用、版の決定は「構造的に解決」する、という二段構えを採る（設計＝deploy `docs/law-rag-setup.md`
「時間軸（as-of）」節）。

- **スキーマ（migration `20260802000000_law_rag_asof`）**：
  - `dwh_laws.enforce_date`（施行日の実カラム化＝`law_id` 中間フィールド `YYYYMMDD`。`01_update_dwh.sql` の
    INSERT が充填。8 桁でない想定外 law_id は NULL）＋ 版解決用 index `(law_num, unique_anchor, enforce_date)`。
  - `app_laws_for_indexing.is_future`（未施行フラグ）。既定モードは retrieve 側で `is_future=false` に絞り
    as-of 導入前（現行索引）と同一集合になる（後方互換）。
  - `law_rag_meta`（単一行）＝データ基準日（e-Gov 取得日）＋配布タグ。api 起動時に 1 度読みキャッシュし、
    レポート「## 出典」節へ 1 行焼き込む（dump 同梱でデータと表示が食い違わない）。
- **索引拡張（`02_rebuild_app_layer.sql`）**：現行版があればその最新（`is_future=false`）、無い条文（将来のみ
  新設・約 2,304 件）は将来版の最早を代表に `is_future=true` で追加する。現行索引の再 embedding は不要で、
  差分充填（`embed_fill.py` が NULL 行だけ）で新規分（≒2,304 件）だけを埋める。
- **retrieve（`src/repositories/lawRetriever.ts` / `src/lib/lawRag/lawReportPipeline.ts`）**：
  API `POST /law-rag/query` の `inputs.as_of_date`（YYYY-MM-DD・任意）。未指定＝現行（版解決を通さない＝
  as-of 導入前と同一）。指定時は未施行も候補に含め、`resolveVersionsAsOf` が `dwh_laws` から as_of 時点の版
  （施行日 ≤ as_of の最新）を解決して本文を差し替え、施行日／未施行／改正予定（次版施行日）を出典に付す。
- **返却契約（web の施行日バッジ用）**：`{outputs, usageMetadata}` に加えて、以下を**兄弟フィールドとして追加**
  する（無い場合は載らない＝`outputs` だけを読む従来クライアントは無改修で動く）。
  - `references[]`＝引用条文ごとの版メタ（`n`＝本文の `[n]` に対応する元番号・非連続を保持／`title`／`url`／
    `enforceDate`／`isFuture`／`nextEnforceDate`）。markdown の「## 出典」と**同じ引用参照**（`resolveCitedReferences`）
    から組み立てるので、焼き込みと構造化メタは必ず一致する。
  - `dataAsOf`＝データ基準日（`law_rag_meta`・未投入なら付かない）／`asOfDate`＝as_of 指定時のみ。
  - 既定モード（as_of 未指定）は版解決を通さないため `enforceDate` は `law_id` 中間フィールドから導出する
    （`enforceDateFromLawId`・追加クエリなし）。索引が現行版のみなので `isFuture` は false、`nextEnforceDate` は
    null（改正予定の解決は as_of 指定時のみ）。
- **この更新（law-rag-20260802）の作り方**：e-Gov は再取得せず、既存 08-01 dwh（配布 dump import 済み）に
  対して ①migrate 適用 → ②修正版 `02_rebuild_app_layer.sql` 再実行（未施行 2,304 件が index へ復活）→
  ③差分 embedding（新規分のみ）→ ④HNSW 再構築 → ⑤`law_rag_meta` 投入 → ⑥export（`law-rag-export.sh` に
  `EGOV_FETCH_DATE=2026-08-01 RELEASE_TAG=law-rag-20260802`）。差分ビルドの embedding 退避・復元
  （D-1〜D-7）と同じ枠組みで、①②が「スキーマ移行＋索引拡張」を担う。

## vector index ベンチ（HNSW vs ivfflat）＋ retrieve live 疎通

取り込み段で「HNSW 仮置き」とした採用を実 255,680 行規模で確定し、retrieve パイプラインを疎通確認する工程。
retrieve 疎通は同梱の `retrieve_smoke.py` を使い捨てコンテナ（psycopg・secret はコンテナ内 `cat`）で回す。
HNSW / ivfflat のベンチ計測はメンテナ環境のベンチ用ハーネス（配布物には含めない）で実施し、下記の結果を採用根拠として記録する。

```bash
cd ~/work/genai-ai-api-onpre/tools/law-rag-ingest
# retrieve 疎通（同梱の retrieve_smoke.py。DB/TEI 接続はコンテナ内で解決）
python3 retrieve_smoke.py                 # self-retrieval + 代表クエリ目視
python3 retrieve_smoke.py --self-only     # self-retrieval Hit/MRR だけ
python3 retrieve_smoke.py --demo-only     # 代表クエリ目視だけ
# HNSW / ivfflat のベンチ計測はメンテナ環境のベンチ用ハーネスで実施（下記結果）
```

- **ベンチ用ハーネス（`bench_vector_index.py`・メンテナ環境のみ）**：seq scan の exact top-k を真値に、HNSW / ivfflat それぞれを
  「その方式の index だけ存在する」状態で構築（直列・`/dev/shm` の DSM 罠回避）→ 構築時間・index サイズ・
  レイテンシ・Recall@k を比較し、終了時に `--keep`（既定 hnsw）へ復元する。
- **`retrieve_smoke.py`**：`pgvector(content_embedding <=> q)` + `pg_bigm(content =% q)` → **RRF**
  （`src/lib/rag/rrf.ts` と同式・k=60/topM=10）。客観指標は self-retrieval（content→同一条文の Hit/MRR）、
  代表クエリは目視疎通用に top-k 表示（関連度ラベルは付けない＝恣意回避）。

### 実機ベンチ結果（2026-06-06・full 255,680 行 / 50 クエリ / k=10・cosine）

| method  | param         | build | size    | median   | Recall@10 |
|---------|---------------|-------|---------|----------|-----------|
| **hnsw**| ef_search=40  | 162s  | 998 MB  | 3.59 ms  | **98.8%** |
| hnsw    | ef_search=100 |       |         | 5.17 ms  | 99.0%     |
| hnsw    | ef_search=200 |       |         | 8.63 ms  | 99.6%     |
| ivfflat | probes=1      | 16s   | 1000 MB | 1.65 ms  | 60.8%     |
| ivfflat | probes=15     |       |         | 17.18 ms | 96.0%     |
| ivfflat | probes=30     |       |         | 33.95 ms | 98.6%     |

**結論＝HNSW 採用確定**。HNSW は ef=40 で 98.8% Recall を 3.59 ms。ivfflat は同等 Recall に probes=30
（33.95 ms＝約 9 倍遅い）を要し recall/latency フロンティアで劣る。ivfflat の利点は構築時間のみで、
配布元 1 回ビルドでは無関係。`sql/03_build_vector_index.sql`（HNSW）を正とする。

### retrieve 疎通の所見（要・設計判断）

- **self-retrieval**：Hit@1 100% / Hit@10 100% / MRR 1.000（30 条文）＝vector + bigm + RRF の配線は健全。
- **【事実】pg_bigm は NL クエリにほぼ寄与しない**：「労働者の時間外労働の上限と割増賃金」で
  `similarity_limit=0.2`（本番既定）の bigm ヒットは 0 件、全行の最大 `bigm_similarity` も 0.107。
  短い NL クエリ × 長い条文では 2-gram 類似度が閾値に届かず、**ハイブリッド検索が NL 検索では vector
  単独に縮退**する。閾値引き下げ（0.05 で 58 件だが雑音増）か、vector + reranker 路線かは設計判断。
- **【事実】範囲削除条文が 3,692 件残存**：`content` が「第○条及び第○条 削除」だけの行が App 層に残り、
  検索ノイズになる（取り込みパースの `Delete="true"` 除外は個別条文のみで範囲削除を取りこぼす）。
  根治は `xml_to_jsonl.py` 側の範囲削除除外、または App 層再構築 SQL でのフィルタ（要判断）。

> 単体テストは `retrieve_smoke.py` の純関数（Recall/MRR・RRF・pg_bigm `=%` の psycopg エスケープ）まで。
> 実 DB/TEI を伴う計測は配布元環境で実機確認する。ベンチ用ハーネスのログは
> `<deploy>/.law-build/m2-bench.<時刻>.log`。

### 所見 A 対処: RRF 単体 vs +reranker のラベル付き評価（`law_rag_eval.py`）

所見 A（NL クエリで pg_bigm 縮退 → vector 単独）を **cross-encoder reranker**（ruri-v3-reranker・TEI native
`/rerank`）で補正できるかを、既存ラベル `deploy/scripts/law-queries.json`（`{q, needle, law}` 20 件・過去の
法令リランカ検証で使用）で検証する。**full `app_laws_for_indexing`（255,680 行）** に対し、vector + bigm → RRF
で候補プールを作り、`needle ∈ content` を正解判定として Hit@1 / Hit@10 / MRR を RRF 単体と +reranker で比較する。

```bash
# 同梱の law_rag_eval.py を使い捨てコンテナで実行（要 tei-reranker: profile rerank 起動）
python3 law_rag_eval.py --eval-file <law-queries.json>                  # RRF vs +rerank 比較
python3 law_rag_eval.py --eval-file <law-queries.json> --candidates 100 # 候補プールを広げて recall 天井を見る
```

実機結果（2026-06-06・full 255,680 行 / ラベル 20 件 / k=10）:

| 構成 | Hit@1 | Hit@10 | MRR |
|------|-------|--------|-----|
| RRF 単体 (cand=20) | 25.0% | 45.0% | 0.32 |
| **+reranker (cand=20)** | **45.0%** | 55.0% | 0.48 |
| **+reranker (cand=100)** | **50.0%** | **65.0%** | **0.56** |

- **reranker は必須かつ有効**：Hit@1 を 25%→50%（2 倍）、MRR 0.32→0.56。候補プール拡大（20→100）で Hit@10
  55%→65%。所見 A の補正方向は実証された。
- **残る天井＝候補生成（recall）律速**：candidates=100 でも 7/20 は正解条文が vector top-100 にすら入らない。
  reranker は並べ替えのみで recall は上げられない。次のレバーは embedding 品質（int8→fp32・PLaMo）／所見 B の
  範囲削除 stub 除去（プール枠の浪費削減）。過去の 45%→90% は curated 29 法令の小コーパスで、full 255k 法令
  条文は同名・類似条文が桁違いに多く retrieval が本質的に難しい点に留意。
- **本番配線への含意**：法令 retrieve を src へ配線する際は **rerank 有効＋候補プール ≥100** を既定に。
  ただし production 品質は recall 改善（embedding／クレンジング）とセットで詰める必要がある。

### 所見 B 対処: 範囲削除 stub の除外

`content` が「削除」だけの範囲/単条削除条文（`<Article>` に `Delete="true"` が付かず本文 Sentence が「削除」
のみ・例「第五条及び第六条／削除」）が App 層に 3,692 件残り検索ノイズになっていた。**取り込み側と App 層
再構築の二重で除外**する:

- `xml_to_jsonl.is_deletion_stub(content)`：先頭（タイトル）行を除いた本文を trim して「削除」だけなら除外。
  実データ 255,680 行で偽陽性 0・本文に「削除」を含む正当条文 568 件は保持を確認。`parse_law_xml` が
  `Delete="true"`・改正附則に加えこの stub も除外する（durable な取り込み時フィルタ）。
- `sql/02_rebuild_app_layer.sql`：App 層再構築の `INSERT ... WHERE` にも同条件を追加（防御的二重化＝
  汚れた dwh から再構築しても App 層に stub が入らない）。
- 既存 DB は再 embed を避けるため対象行のみ `DELETE`（embedding 温存・255,680→251,988 行）で除去した。

**効果（ラベル評価で再測定）**：stub 除去は **labeled recall を改善しない**（Hit@10 は cand=20/100 とも除去前後で
不変 55%/65%）。20 ラベルの miss は stub 変位ではなく真の候補生成 recall 失敗のため。除去は無意味行の排除・
削除関連クエリのノイズ解消・候補枠の節約としては正しいが、**recall 律速の根治は embedding 品質側**にある
（→ 本番 src 配線後、int8→fp32／PLaMo を別途検証）。

## パース仕様（移植の要点）

- パーサは標準ライブラリ `xml.etree.ElementTree`。外部ライブラリ（`ja-law-parser` 等）は使わない。
- チャンク単位は **条（Article）**。`unique_anchor = "{Main|Suppl}_Article_{Num}"`。
- **本則（MainProvision）＋原始附則**のみ取り込む。**廃止条文（`Delete="true"`）と改正附則
  （`AmendLawNum` 属性付き `SupplProvision`）は除外**。
- e-Gov リンク用アンカーは本則のみ（`Mp-At_{Num}`）。附則は `null`。
- `content` は条の階層（Paragraph / Item / Subitem…）を全角スペースインデントで平坦化。
- 元号→西暦変換（Meiji=1867 / Taisho=1911 / Showa=1925 / Heisei=1988 / Reiwa=2018 + 年）。

## テスト

```bash
# リポジトリルートから
python3 -m unittest discover -s tools/law-rag-ingest/tests -v
```

## ライセンス・由来（attribution）

XML パースロジック（`parse_law_xml` / `format_article_text`）と、DB 投入の MERGE / App 層再構築
SQL（`sql/01_update_dwh.sql` / `sql/02_rebuild_app_layer.sql`）は、Digital Agency of Japan が公開する
`lawsy-custom-bq/preprocess/`（`load_to_bq.py` / `run_bq_pipeline.py` / `sql/`、**MIT License**,
Copyright (c) 2026 Digital Agency of Japan）から移植した。GCS / BigQuery I/O は除去し、BigQuery
固有構文（`MERGE` / `DENSE_RANK` / `ROW_NUMBER`）は標準 PostgreSQL へ、`ML.GENERATE_EMBEDDING` と
`CREATE VECTOR INDEX` はアプリ層 embedding 生成と pgvector index へ置換している。
ライセンス本文は `LICENSES-THIRD-PARTY/`（`digital-go-jp_genai-ai-api_MIT.txt` /
`digital-go-jp_genai-ai-api_CC-BY-4.0.txt`。lawsy-custom-bq は上流リポジトリルートの LICENSE を参照する
構成のため同ファイルが適用される）に保全済みで、取扱は `NOTICE`「lawsy-custom-bq 派生物の取扱」節に記載している。

法令データそのものは e-Gov 法令検索の利用規約（商用可・出典記載・編集/加工記載・CC BY 4.0 互換）に従う。
JSONL / DB dump として再配布する際は、配布物に出典（e-Gov）・加工した旨・ライセンスを明記すること。

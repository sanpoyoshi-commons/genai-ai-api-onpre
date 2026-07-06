#!/usr/bin/env bash
# =============================================================================
# 法令 RAG M2 — embedding 全量充填 → HNSW 全量再構築 オーケストレータ
#
# 用途:
#   配布元端末で（nohup 放置）長時間（概算 47h 規模）回すための一括スクリプト。
#   postgres + tei(embedding profile) を起動 → embed_fill.py で NULL embedding を全量充填
#   → 完了後に HNSW vector index を全量再構築 → 充填件数と index を検証する。
#
#   ・embed_fill.py は「embedding が NULL の行だけ」を埋める再開可能設計。
#     途中で中断・落ちても、本スクリプトを再実行すれば残りだけ続行する（冪等）。
#   ・secret の値はホスト/ログに出さない。postgres_password は使い捨てコンテナ／
#     postgres コンテナの中で `cat /run/secrets/postgres_password` して libpq に渡す
#     （load_to_db.py と同じパターン）。
#
# 前提:
#   ・docker / docker compose 利用可。
#   ・deploy リポに secrets/postgres_password と tei/models/<int8 モデル> が用意済み
#     （docker-compose.secrets.yml / scripts/gen-secrets.sh / scripts/export-ruri-onnx.sh）。
#   ・M1（load_to_db.py）完了済＝app_laws_master / app_laws_for_indexing にデータ投入済・
#     embedding 列は NULL。
#   ・RAM 12GB 機では充填中に 7B 級 LLM(ollama 等) を同時起動しないこと（OOM）。
#
# 実行例（nohup 放置・推奨）:
#   cd ~/work/genai-ai-api-onpre/tools/law-rag-ingest
#   nohup ./run_m2_fill.sh > /dev/null 2>&1 &
#   # 進捗はスクリプトが吐くログファイル（実行時に表示されるパス）を tail -f で追う。
#
# オプション:
#   --fill-only     充填のみ（HNSW 構築をスキップ）
#   --index-only    HNSW 構築のみ（充填をスキップ。充填が別途完了済のとき）
#   --target both|content|title   充填対象（既定 both）
#
# 環境変数で上書き可（既定値）:
#   DEPLOY_DIR=~/work/genai-deploy-onpre   compose/secrets/tei モデルのある場所
#   PGUSER=genai  PGDATABASE=genai                    postgres のユーザ/DB（.env と合わせる）
#   TEI_URL=http://tei:80                             TEI ネイティブ /embed のベース URL
#   PYTHON_IMAGE=python:3.12-slim                     充填用使い捨てコンテナ
#   BATCH=8                                           TEI への 1 リクエスト件数（max-client-batch-size）
#   PAGE=256                                          DB ページ/commit 粒度
#   NETWORK=<compose project>_genai_internal          使い捨てコンテナが繋ぐ docker network
# =============================================================================
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_DIR="${DEPLOY_DIR:-$HOME/work/genai-deploy-onpre}"
PGUSER="${PGUSER:-genai}"
PGDATABASE="${PGDATABASE:-genai}"
TEI_URL="${TEI_URL:-http://tei:80}"
PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.12-slim}"
BATCH="${BATCH:-8}"
PAGE="${PAGE:-256}"
NETWORK="${NETWORK:-genai-local_genai_internal}"

TARGET="both"
DO_FILL=1
DO_INDEX=1
while [ $# -gt 0 ]; do
  case "$1" in
    --fill-only)  DO_INDEX=0 ;;
    --index-only) DO_FILL=0 ;;
    --target)     TARGET="${2:?--target は both|content|title}"; shift ;;
    --target=*)   TARGET="${1#--target=}" ;;
    -h|--help)    sed -n '2,55p' "$0"; exit 0 ;;
    *) echo "ERROR: 未知の引数: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$TARGET" in both|content|title) ;; *) echo "ERROR: --target は both|content|title" >&2; exit 2 ;; esac

COMPOSE_YML="$DEPLOY_DIR/docker-compose.yml"
SECRETS_YML="$DEPLOY_DIR/docker-compose.secrets.yml"
SECRET_FILE="$DEPLOY_DIR/secrets/postgres_password"

LOG_DIR="$DEPLOY_DIR/.law-build"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/m2-embed-fill.$(date +%Y%m%d-%H%M%S).log"
# 標準出力/エラーをログにも複製（nohup でも後から追える）。
exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '\n=== [%s] %s ===\n' "$(date +%H:%M:%S)" "$*"; }

# compose ラッパ（base + secrets overlay、相対パス解決のため project-directory を deploy に固定）。
dc() { docker compose --project-directory "$DEPLOY_DIR" -f "$COMPOSE_YML" -f "$SECRETS_YML" "$@"; }

log "M2 充填オーケストレータ開始（log: $LOG_FILE）"
echo "DEPLOY_DIR=$DEPLOY_DIR  TARGET=$TARGET  FILL=$DO_FILL  INDEX=$DO_INDEX  NETWORK=$NETWORK"

# ---- 0. プリフライト -------------------------------------------------------
log "プリフライト"
command -v docker >/dev/null || { echo "ERROR: docker が見つからない" >&2; exit 1; }
for f in "$COMPOSE_YML" "$SECRETS_YML" "$SECRET_FILE" "$TOOL_DIR/embed_fill.py" "$TOOL_DIR/sql/03_build_vector_index.sql"; do
  [ -e "$f" ] || { echo "ERROR: 必須ファイル不在: $f" >&2; exit 1; }
done
echo "OK: compose / secret / tool 確認"

# ---- 1. postgres + tei 起動（embedding profile） ----------------------------
log "postgres + tei 起動（--profile embedding）"
dc --profile embedding up -d postgres tei

log "postgres ready 待ち"
until dc exec -T postgres pg_isready -U "$PGUSER" -d "$PGDATABASE" >/dev/null 2>&1; do
  echo "  …postgres 起動待ち"; sleep 3
done
echo "OK: postgres ready"

if [ "$DO_FILL" = 1 ]; then
  log "tei /health 待ち（モデルロードに時間がかかる場合あり）"
  until docker run --rm --network "$NETWORK" "$PYTHON_IMAGE" \
        python3 -c "import urllib.request; urllib.request.urlopen('$TEI_URL/health', timeout=5)" >/dev/null 2>&1; do
    echo "  …tei 起動待ち"; sleep 5
  done
  echo "OK: tei ready"
fi

# ---- 2. embedding 全量充填（再開可能・使い捨てコンテナ） ---------------------
if [ "$DO_FILL" = 1 ]; then
  log "embedding 充填開始（target=$TARGET / batch=$BATCH / page=$PAGE）— ここが長時間（概算 47h 規模）"
  docker run --rm --name law-rag-embed-fill \
    --network "$NETWORK" \
    -v "$TOOL_DIR":/tool:ro \
    -v "$SECRET_FILE":/run/secrets/postgres_password:ro \
    -e PGHOST=postgres -e PGUSER="$PGUSER" -e PGDATABASE="$PGDATABASE" \
    -e TARGET="$TARGET" -e BATCH="$BATCH" -e PAGE="$PAGE" -e TEI_URL="$TEI_URL" \
    "$PYTHON_IMAGE" \
    sh -c 'set -e
      pip install --quiet --no-cache-dir "psycopg[binary]"
      export PGPASSWORD="$(cat /run/secrets/postgres_password)"
      exec python3 /tool/embed_fill.py \
        --target "$TARGET" --order pk --batch "$BATCH" --page "$PAGE" --tei-url "$TEI_URL"'
  echo "OK: 充填完了"
else
  log "充填スキップ（--index-only）"
fi

# ---- 3. HNSW 全量再構築 -----------------------------------------------------
if [ "$DO_INDEX" = 1 ]; then
  log "HNSW vector index 全量再構築（sql/03_build_vector_index.sql）"
  dc exec -T -e PGUSER="$PGUSER" -e PGDATABASE="$PGDATABASE" postgres \
    sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDATABASE" -f -' \
    < "$TOOL_DIR/sql/03_build_vector_index.sql"
  echo "OK: HNSW 構築完了"
else
  log "HNSW 構築スキップ（--fill-only）"
fi

# ---- 4. 検証 ---------------------------------------------------------------
log "検証（充填件数 / index 一覧）"
dc exec -T -e PGUSER="$PGUSER" -e PGDATABASE="$PGDATABASE" postgres \
  sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" psql -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=0' <<'SQL'
SELECT 'content' AS target, count(*) AS total, count(content_embedding) AS filled,
       count(*) - count(content_embedding) AS still_null
  FROM app_laws_for_indexing
UNION ALL
SELECT 'title', count(*), count(law_title_embedding),
       count(*) - count(law_title_embedding)
  FROM app_laws_master;
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
 WHERE indexrelname LIKE '%emb_hnsw_idx';
SQL

log "完了。tei は起動継続（停止しない選択）。postgres も M2 検証用に継続。"
echo "ログ全文: $LOG_FILE"

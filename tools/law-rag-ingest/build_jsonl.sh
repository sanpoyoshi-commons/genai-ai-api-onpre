#!/usr/bin/env bash
#
# build_jsonl.sh — 法令 RAG 前処理ラッパー。
#
# all_xml.zip（e-Gov 法令標準 XML 一括）を展開し、xml_to_jsonl.py で条単位チャンク化して
# data.jsonl を生成するまでを一括実行する。**配布元の手元端末で回す重い CPU 工程**。
# DB も secret も不要・python3 標準ライブラリのみで完結する（DB 投入はこのスクリプトの範囲外）。
#
#   入力 : all_xml.zip                （--zip、既定は実行時 CWD の ./all_xml.zip）
#   中間 : <out>/egov_xml/**/*.xml      （展開先、再実行時は既定でスキップ）
#   出力 : <out>/data.jsonl             （11 カラム JSONL・後段 load_to_db.py の入力）
#
# 使い方（deploy リポのルートで実行する想定）:
#   bash ../genai-ai-api-onpre/tools/law-rag-ingest/build_jsonl.sh
#   bash .../build_jsonl.sh --zip ./all_xml.zip --out ./.law-build --jobs 6
#   bash .../build_jsonl.sh --force        # 展開済みでも XML を作り直す
#
set -euo pipefail

# このスクリプト自身のディレクトリ＝xml_to_jsonl.py の置き場。実行 CWD に依存せず解決する。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONVERTER="${SCRIPT_DIR}/xml_to_jsonl.py"

# --- 既定値 ----------------------------------------------------------------
ZIP="${PWD}/all_xml.zip"   # 実行時 CWD（=deploy ルート想定）の zip を既定にする
OUT_DIR=""                 # 未指定なら zip と同じ場所の .law-build/ にする
JOBS=""                    # 未指定なら xml_to_jsonl.py が CPU 数を使う
FORCE=0

# 先頭の連続するコメント行（シバンを除く）だけをヘルプとして出す。
usage() { sed -n '2,${/^[^#]/q;p;}' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip)  ZIP="$2"; shift 2 ;;
    --out)  OUT_DIR="$2"; shift 2 ;;
    --jobs|-j) JOBS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "ERROR: unknown arg: $1" >&2; usage 1 ;;
  esac
done

# --- 前提チェック ----------------------------------------------------------
command -v python3 >/dev/null || { echo "ERROR: python3 が見つかりません" >&2; exit 1; }
[[ -f "$CONVERTER" ]] || { echo "ERROR: xml_to_jsonl.py が見つかりません: $CONVERTER" >&2; exit 1; }
[[ -f "$ZIP" ]] || { echo "ERROR: zip が見つかりません: $ZIP（--zip で指定）" >&2; exit 1; }

ZIP="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"   # 絶対パス化
[[ -n "$OUT_DIR" ]] || OUT_DIR="$(dirname "$ZIP")/.law-build"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
XML_DIR="${OUT_DIR}/egov_xml"
JSONL="${OUT_DIR}/data.jsonl"

echo "==[build_jsonl] 設定 =="
echo "  zip   : $ZIP ($(du -h "$ZIP" | cut -f1))"
echo "  out   : $OUT_DIR"
echo "  jobs  : ${JOBS:-auto(CPU数)}"
echo "  force : $FORCE"
echo "  空き  : $(df -h "$OUT_DIR" | awk 'NR==2{print $4}') (展開＋JSONL で数 GB 使う場合あり)"
echo

# --- 1) 展開（*.xml のみ・再実行はスキップ） --------------------------------
existing_xml=$(find "$XML_DIR" -type f -name '*.xml' 2>/dev/null | head -1 || true)
if [[ -n "$existing_xml" && "$FORCE" -eq 0 ]]; then
  n=$(find "$XML_DIR" -type f -name '*.xml' | wc -l)
  echo "==[1/3] 展開: スキップ（既に ${n} 件の XML が ${XML_DIR} にあります。作り直すなら --force）"
else
  [[ "$FORCE" -eq 1 ]] && rm -rf "$XML_DIR"
  mkdir -p "$XML_DIR"
  echo "==[1/3] 展開: ${ZIP} → ${XML_DIR}（*.xml のみ・python3 zipfile）…"
  # unzip に依存せず python3 標準ライブラリで展開する（zip-slip 対策＝展開先配下チェック）。
  python3 - "$ZIP" "$XML_DIR" <<'PY'
import os, sys, zipfile
zip_path, dest = sys.argv[1], os.path.abspath(sys.argv[2])
n = 0
with zipfile.ZipFile(zip_path) as zf:
    for info in zf.infolist():
        if info.is_dir() or not info.filename.lower().endswith(".xml"):
            continue
        target = os.path.abspath(os.path.join(dest, info.filename))
        # zip-slip: 展開先ディレクトリの外を指すエントリは拒否する。
        if target != dest and not target.startswith(dest + os.sep):
            print(f"WARN: skip unsafe entry: {info.filename}", file=sys.stderr)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as out:
            out.write(src.read())
        n += 1
        if n % 2000 == 0:
            print(f"INFO: extracted {n} xml …", file=sys.stderr)
print(f"INFO: extracted {n} xml total", file=sys.stderr)
PY
  n=$(find "$XML_DIR" -type f -name '*.xml' | wc -l)
  echo "    展開完了: ${n} 件の XML"
fi

# --- 2) JSONL 生成（重い工程・進捗は stderr へ） ----------------------------
echo "==[2/3] JSONL 生成: xml_to_jsonl.py（500 件ごとに進捗を表示）…"
JOBS_ARGS=()
[[ -n "$JOBS" ]] && JOBS_ARGS=(-j "$JOBS")
TMP="${JSONL}.partial"
rm -f "$TMP"
# 途中失敗で中途半端な data.jsonl を残さないよう .partial に書いてから差し替える。
python3 "$CONVERTER" "$XML_DIR" -o "$TMP" "${JOBS_ARGS[@]}"
mv -f "$TMP" "$JSONL"

# --- 3) 健全性チェック ------------------------------------------------------
echo "==[3/3] 健全性チェック …"
rows=$(wc -l < "$JSONL")
size=$(du -h "$JSONL" | cut -f1)
echo "    行数(チャンク)   : ${rows}"
echo "    ファイルサイズ   : ${size}"
# 先頭/末尾行が JSON として妥当か、distinct law_id 数、サンプル 1 行を確認する。
python3 - "$JSONL" <<'PY'
import json, sys
path = sys.argv[1]
law_ids, anchors, bad = set(), 0, 0
first = None
with open(path, encoding="utf-8") as f:
    for i, line in enumerate(f):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            bad += 1
            continue
        if first is None:
            first = r
        law_ids.add(r.get("law_id"))
        if r.get("anchor"):
            anchors += 1
print(f"    distinct law_id  : {len(law_ids)}")
print(f"    本則アンカー有り : {anchors}（附則は anchor=null 想定）")
print(f"    壊れた行(JSON不正): {bad}")
if first:
    print("    サンプル先頭行   :")
    print(f"      law_title    = {first.get('law_title')}")
    print(f"      law_num      = {first.get('law_num')}")
    print(f"      unique_anchor= {first.get('unique_anchor')}")
    print(f"      promulgate   = {first.get('promulgate_date')} (era={first.get('era')}, year={first.get('year')})")
    c = (first.get("content") or "").splitlines()
    print(f"      content先頭  = {c[0] if c else ''}")
if bad:
    sys.exit(2)
PY

echo
echo "==[完了] data.jsonl: ${JSONL}"
echo "次工程（手動）:"
echo "  ② スキーマ適用 : deploy で migrate サービス起動（prisma migrate deploy）"
echo "  ③ DB 投入      : python3 load_to_db.py \"${JSONL}\" --dsn postgresql://…（psycopg 必要）"

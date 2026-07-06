"""法令 RAG App 層の embedding 列（vector(768)）を TEI/ruri-768 で生成・充填する配布元ビルド時ツール。

法令 RAG のデータ取り込みパイプライン。
取り込み（load_to_db.py）で投入済みの 2 列を埋める:

    app_laws_for_indexing.content_embedding  ← content        （本文ベクトル検索対象・255,680 行規模）
    app_laws_master.law_title_embedding      ← law_title      （法令名ベクトル検索・7,813 行規模）

設計:
  - **再開可能**：embedding 列が NULL の行だけを SELECT → embed → UPDATE。中断しても次回は残りだけ。
  - **バッチ**：TEI は --max-client-batch-size 8 / --max-batch-tokens 4096。1 リクエスト最大 8 件。
    長条文（条単位チャンク・チャンク分割なし）は truncate=true で吸収（pg_bigm 全文は full を保持・RRF で補完）。
    バッチが max-batch-tokens を超えて TEI が拒否した場合は半分に分割して再試行（adaptive）。
  - **モデル一致**：ingest と retrieve は同一 TEI（compose 既定＝ruri-v3-310m-onnx-int8）を叩く。
    類似度はモデル一致が前提のため、retrieve 側 EMBEDDING_MODEL_PATH を変えたら本充填もやり直すこと。
  - **prefix なし**：既存 RagService の retrieve と揃えて raw text を送る（ruri の検索クエリ/文書 prefix は未導入）。

由来（attribution）:
    法令 RAG は Digital Agency of Japan の lawsy-custom-bq（MIT License）を pgvector へ移植したもの。
    BQML の ML.GENERATE_EMBEDDING に相当する工程を、ローカル TEI（ruri-768）への HTTP 呼び出しで置換する。

使い方:
    # libpq 環境変数（PGHOST/PGUSER/PGPASSWORD/PGDATABASE）+ TEI_URL で接続
    python3 embed_fill.py --target both
    python3 embed_fill.py --target content --limit 16   # スモークテスト（先頭 16 行だけ）
    python3 embed_fill.py --target title  --tei-url http://tei:80

注意:
    psycopg（v3）が必要。純関数（ベクトル整形・バッチ分割・TEI ペイロード構築）は psycopg / ネットワーク
    なしで import・テストできるよう、psycopg と HTTP 呼び出しは実際に使う関数の中で行う。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any, Iterable, Iterator, Sequence

# 充填対象の定義。retrieve 側の参照列名と必ず一致させること。
TARGETS: dict[str, dict[str, Any]] = {
    "content": {
        "table": "app_laws_for_indexing",
        "text_col": "content",
        "emb_col": "content_embedding",
        "pk_cols": ("law_num", "unique_anchor"),
    },
    "title": {
        "table": "app_laws_master",
        "text_col": "law_title",
        "emb_col": "law_title_embedding",
        "pk_cols": ("law_num",),
    },
}


# ---- 純関数（psycopg / ネットワーク不要・ユニットテスト対象） ----------------------------


def to_pgvector(vec: Sequence[float]) -> str:
    """float 配列を pgvector のテキスト表現 '[0.1,0.2,...]' に整形する（::vector でキャストする前提）。"""
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


def batched(items: Sequence[Any], size: int) -> Iterator[list[Any]]:
    """items を最大 size 件ずつのリストに分割して yield する（size>=1）。"""
    if size < 1:
        raise ValueError("size must be >= 1")
    for i in range(0, len(items), size):
        yield list(items[i : i + size])


def build_embed_payload(texts: Sequence[str], truncate: bool = True) -> bytes:
    """TEI ネイティブ /embed のリクエストボディ（JSON bytes）を作る。"""
    body: dict[str, Any] = {"inputs": list(texts), "truncate": truncate}
    return json.dumps(body).encode("utf-8")


def parse_embed_response(raw: bytes) -> list[list[float]]:
    """TEI /embed のレスポンス（[[...],[...]]）を float 配列のリストに変換する。"""
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError(f"unexpected TEI /embed response shape: {type(data).__name__}")
    return [[float(x) for x in row] for row in data]


# ---- ネットワーク（TEI 呼び出し） --------------------------------------------------------


def embed_texts(
    texts: Sequence[str],
    tei_url: str,
    *,
    truncate: bool = True,
    timeout: float = 300.0,
) -> list[list[float]]:
    """texts を TEI /embed で埋め込む。バッチが大きすぎて TEI が拒否したら半分に分割して再試行する。"""
    if not texts:
        return []
    url = tei_url.rstrip("/") + "/embed"
    req = urllib.request.Request(
        url,
        data=build_embed_payload(texts, truncate=truncate),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return parse_embed_response(resp.read())
    except urllib.error.HTTPError as exc:
        # 413/422 等：バッチが max-batch-tokens 超過の可能性 → 1 件まで分割して再試行。
        if exc.code in (413, 422, 400) and len(texts) > 1:
            mid = len(texts) // 2
            left = embed_texts(texts[:mid], tei_url, truncate=truncate, timeout=timeout)
            right = embed_texts(texts[mid:], tei_url, truncate=truncate, timeout=timeout)
            return left + right
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"TEI /embed HTTP {exc.code} for {len(texts)} input(s): {detail}") from exc


# ---- DB 充填（psycopg 遅延 import） ------------------------------------------------------


def fill_target(
    target_key: str,
    *,
    dsn: str | None,
    tei_url: str,
    batch: int = 8,
    page: int = 256,
    limit: int | None = None,
    order: str = "pk",
    log_every: int = 5_000,
) -> int:
    """1 ターゲット（content / title）の embedding 列を NULL 行のみ充填し、充填行数を返す。

    order='pk' は主キー順（決定的・全充填向き）。order='md5' は md5(pk) 疑似ランダム順で、
    subset 充填時に法令を広くカバーする代表サンプルを得る（ベンチ用）。md5 順 + --limit で
    途中再開すると subset 境界が overshoot しうる（残 NULL の最小 md5 から続けるため）が、
    ベンチ subset では無害（データは正しい・行数が増えるだけ）。
    """
    import psycopg

    t = TARGETS[target_key]
    table, text_col, emb_col, pk_cols = t["table"], t["text_col"], t["emb_col"], t["pk_cols"]
    pk_select = ", ".join(pk_cols)
    pk_where = " AND ".join(f"{c} = %s" for c in pk_cols)
    if order == "md5":
        order_by = "md5(" + " || ".join(f"{c}::text" for c in pk_cols) + ")"
    else:
        order_by = pk_select

    select_sql = (
        f"SELECT {pk_select}, {text_col} FROM {table} "
        f"WHERE {emb_col} IS NULL AND {text_col} IS NOT NULL AND {text_col} <> '' "
        f"ORDER BY {order_by} LIMIT %s"
    )
    update_sql = f"UPDATE {table} SET {emb_col} = %s::vector WHERE {pk_where}"

    filled = 0
    with psycopg.connect(dsn or "") as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM {table} WHERE {emb_col} IS NULL")
            remaining = cur.fetchone()[0]
            print(f"INFO[{target_key}]: {remaining} rows with NULL {emb_col} to fill", file=sys.stderr)

            while True:
                take = page if limit is None else min(page, limit - filled)
                if take <= 0:
                    break
                cur.execute(select_sql, (take,))
                rows = cur.fetchall()
                if not rows:
                    break

                updates: list[tuple] = []
                for chunk in batched(rows, batch):
                    texts = [r[-1] for r in chunk]
                    vecs = embed_texts(texts, tei_url)
                    if len(vecs) != len(chunk):
                        raise RuntimeError(
                            f"TEI returned {len(vecs)} vectors for {len(chunk)} inputs"
                        )
                    for row, vec in zip(chunk, vecs):
                        pk_vals = row[:-1]
                        updates.append((to_pgvector(vec), *pk_vals))

                cur.executemany(update_sql, updates)
                conn.commit()
                filled += len(updates)
                if filled % log_every < len(updates):
                    print(f"INFO[{target_key}]: filled {filled} rows …", file=sys.stderr)

                if limit is not None and filled >= limit:
                    break

    print(f"INFO[{target_key}]: done. {filled} rows filled.", file=sys.stderr)
    return filled


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fill law RAG embedding columns via TEI/ruri-768 (law RAG)."
    )
    parser.add_argument(
        "--target",
        choices=["content", "title", "both"],
        default="both",
        help="which embedding column to fill (default: both)",
    )
    parser.add_argument(
        "--dsn",
        default=None,
        help="PostgreSQL DSN (default: libpq env vars PGHOST/PGUSER/PGDATABASE/…)",
    )
    parser.add_argument(
        "--tei-url",
        default="http://tei:80",
        help="TEI base URL (native /embed; default: http://tei:80)",
    )
    parser.add_argument("--batch", type=int, default=8, help="TEI inputs per request (<= max-client-batch-size, default 8)")
    parser.add_argument("--page", type=int, default=256, help="rows per DB page / commit (default 256)")
    parser.add_argument(
        "--order",
        choices=["pk", "md5"],
        default="pk",
        help="row pick order: pk (deterministic, full fill) or md5 (pseudo-random subset for bench)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="stop after filling this many rows per target (smoke test; default: all)",
    )
    args = parser.parse_args(argv)

    targets = ["content", "title"] if args.target == "both" else [args.target]
    total = 0
    for key in targets:
        total += fill_target(
            key,
            dsn=args.dsn,
            tei_url=args.tei_url,
            batch=args.batch,
            page=args.page,
            limit=args.limit,
            order=args.order,
        )
    print(f"INFO: all done. {total} rows filled across {targets}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""JSONL（xml_to_jsonl.py の出力）を PostgreSQL の法令 RAG 3 層へ投入する配布元ビルド時ツール。

法令 RAG のデータ取り込みパイプライン。
1 取り込みバッチを次の順でトランザクション実行する:

    JSONL → TEMP ステージング（COPY）
          → dwh_laws へ MERGE（sql/01_update_dwh.sql）
          → app_laws_master / app_laws_for_indexing を再構築（sql/02_rebuild_app_layer.sql）

embedding 生成と vector index は後段（ここでは embedding 列は NULL のまま）。

由来（attribution）:
    Derived from Digital Agency of Japan's `lawsy-custom-bq/preprocess/load_to_bq.py` /
    `run_bq_pipeline.py`（MIT License, Copyright (c) 2026 Digital Agency of Japan）。
    GCS 一時置き場と BigQuery ロードを除去し、ローカルファイルから PostgreSQL へ直接 COPY/MERGE
    する構成へ移植。MERGE / App 層再構築の SQL は sql/ 配下（同じく移植）。

使い方:
    python3 load_to_db.py data.jsonl --dsn postgresql://user:pass@host:5432/db
    python3 xml_to_jsonl.py <xml_dir> | python3 load_to_db.py - --dsn ...
    --dsn 省略時は libpq 環境変数（PGHOST / PGUSER / PGPASSWORD / PGDATABASE …）を使う。

注意:
    psycopg（v3）が必要。純関数（SQL 分割・行型変換・JSONL 読み込み）は psycopg なしで
    import・テストできるよう、psycopg は実際に接続する関数の中で遅延 import する。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import IO, Any

SQL_DIR = Path(__file__).resolve().parent / "sql"

# ステージング表の列（JSONL 11 カラムと同順）。COPY の列指定・型指定にこの順序を使う。
STAGING_COLUMNS = [
    "law_id",
    "law_num",
    "law_title",
    "unique_anchor",
    "anchor",
    "content",
    "article_summary",
    "era",
    "year",
    "law_type",
    "promulgate_date",
]

# COPY set_types 用の PG 型名（STAGING_COLUMNS と同順）。全 NULL 列でも型推論に頼らないため明示。
STAGING_PG_TYPES = [
    "text",
    "text",
    "text",
    "text",
    "text",
    "text",
    "text",
    "text",
    "int4",
    "text",
    "date",
]

# dwh_laws と同じ列構成の TEMP 表。バッチ終了（COMMIT）で自動破棄する。
STAGING_DDL = """
CREATE TEMP TABLE _law_ingest_staging (
    law_id          text NOT NULL,
    law_num         text NOT NULL,
    law_title       text NOT NULL,
    unique_anchor   text NOT NULL,
    anchor          text,
    content         text NOT NULL,
    article_summary text,
    era             text,
    year            integer,
    law_type        text,
    promulgate_date date
) ON COMMIT DROP
"""

COPY_SQL = (
    "COPY _law_ingest_staging ("
    + ", ".join(STAGING_COLUMNS)
    + ") FROM STDIN"
)


def _split_sql_statements(sql_text: str) -> list[str]:
    """SQL スクリプトを文単位に分割する。`--` 行コメントを除去し `;` で区切る。

    sql/ 配下の文字列リテラルには `--` も `;` も含めない前提（移植 SQL は単純な DML/DDL のみ）。
    """
    no_comments: list[str] = []
    for line in sql_text.splitlines():
        idx = line.find("--")
        no_comments.append(line if idx < 0 else line[:idx])
    joined = "\n".join(no_comments)
    return [stmt.strip() for stmt in joined.split(";") if stmt.strip()]


def load_sql(path: Path) -> str:
    """SQL ファイルを読み込む。"""
    return path.read_text(encoding="utf-8")


def _coerce_row(row: dict[str, Any]) -> tuple[Any, ...]:
    """JSONL 1 行（dict）を STAGING_COLUMNS 順のタプルへ変換する。

    year は int、promulgate_date は date、欠損 / 空文字は NULL（None）へ正規化する。
    """

    def text_or_none(value: Any) -> str | None:
        return value if value not in (None, "") else None

    year_raw = row.get("year")
    year = int(year_raw) if year_raw is not None and year_raw != "" else None

    date_raw = row.get("promulgate_date")
    promulgate_date = date.fromisoformat(date_raw) if date_raw else None

    return (
        row["law_id"],
        row["law_num"],
        row["law_title"],
        row["unique_anchor"],
        text_or_none(row.get("anchor")),
        row["content"],
        text_or_none(row.get("article_summary")),
        text_or_none(row.get("era")),
        year,
        text_or_none(row.get("law_type")),
        promulgate_date,
    )


def iter_jsonl_rows(fileobj: IO[str]):
    """JSONL を 1 行ずつ dict として yield する（空行はスキップ）。"""
    for line in fileobj:
        line = line.strip()
        if line:
            yield json.loads(line)


def ingest(rows, dsn: str | None, sql_dir: Path = SQL_DIR, log_every: int = 50_000) -> int:
    """rows（dict のイテラブル）を 1 トランザクションで投入し、ステージング投入行数を返す。

    psycopg はここで遅延 import する（純関数の import・テストに psycopg を要求しないため）。
    """
    import psycopg

    sql_merge = load_sql(sql_dir / "01_update_dwh.sql")
    sql_rebuild = load_sql(sql_dir / "02_rebuild_app_layer.sql")

    copied = 0
    with psycopg.connect(dsn or "") as conn:
        with conn.cursor() as cur:
            cur.execute(STAGING_DDL)

            with cur.copy(COPY_SQL) as copy:
                copy.set_types(STAGING_PG_TYPES)
                for row in rows:
                    copy.write_row(_coerce_row(row))
                    copied += 1
                    if copied % log_every == 0:
                        print(f"INFO: staged {copied} rows", file=sys.stderr)

            print(f"INFO: staged {copied} rows total. running DWH MERGE …", file=sys.stderr)
            for stmt in _split_sql_statements(sql_merge):
                cur.execute(stmt)

            print("INFO: rebuilding app layer …", file=sys.stderr)
            for stmt in _split_sql_statements(sql_rebuild):
                cur.execute(stmt)

        conn.commit()

    print(f"INFO: done. {copied} rows ingested (embedding は後段)。", file=sys.stderr)
    return copied


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="JSONL -> PostgreSQL law RAG 3-layer ingest (law RAG)."
    )
    parser.add_argument(
        "jsonl",
        help="input JSONL path produced by xml_to_jsonl.py ('-' for stdin)",
    )
    parser.add_argument(
        "--dsn",
        default=None,
        help="PostgreSQL DSN (default: libpq env vars PGHOST/PGUSER/PGDATABASE/…)",
    )
    parser.add_argument(
        "--sql-dir",
        type=Path,
        default=SQL_DIR,
        help=f"directory holding 01/02 SQL (default: {SQL_DIR})",
    )
    args = parser.parse_args(argv)

    if args.jsonl == "-":
        ingest(iter_jsonl_rows(sys.stdin), args.dsn, args.sql_dir)
    else:
        with open(args.jsonl, encoding="utf-8") as f:
            ingest(iter_jsonl_rows(f), args.dsn, args.sql_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

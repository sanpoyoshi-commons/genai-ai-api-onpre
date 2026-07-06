"""load_to_db の純関数（SQL 分割・行型変換・JSONL 読み込み）の検証（DB 不要・psycopg 不要）。

実行: python3 -m unittest discover -s tools/law-rag-ingest/tests
  DB 接続を伴う ingest() は運用環境（PostgreSQL 16 + pgvector + pg_bigm）で疎通確認する。
"""

import io
import sys
import unittest
from datetime import date
from pathlib import Path

# load_to_db をテストから import できるようにツールのルートを sys.path へ。
TOOL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL_ROOT))

import load_to_db as ld  # noqa: E402


class SplitSqlStatementsTest(unittest.TestCase):
    def test_strips_comments_and_splits(self) -> None:
        sql = """
        -- これはコメント
        TRUNCATE foo;  -- 行末コメント
        INSERT INTO foo VALUES (1);
        """
        stmts = ld._split_sql_statements(sql)
        self.assertEqual(stmts, ["TRUNCATE foo", "INSERT INTO foo VALUES (1)"])

    def test_merge_sql_is_single_statement(self) -> None:
        sql = ld.load_sql(ld.SQL_DIR / "01_update_dwh.sql")
        stmts = ld._split_sql_statements(sql)
        self.assertEqual(len(stmts), 1)
        self.assertTrue(stmts[0].upper().startswith("MERGE INTO DWH_LAWS"))

    def test_rebuild_sql_has_four_statements(self) -> None:
        # TRUNCATE master / INSERT master / TRUNCATE index / INSERT index の 4 文。
        sql = ld.load_sql(ld.SQL_DIR / "02_rebuild_app_layer.sql")
        stmts = ld._split_sql_statements(sql)
        self.assertEqual(len(stmts), 4)
        kinds = [s.split()[0].upper() for s in stmts]
        self.assertEqual(kinds, ["TRUNCATE", "INSERT", "TRUNCATE", "INSERT"])


class CoerceRowTest(unittest.TestCase):
    def _row(self, **over):
        base = {
            "law_id": "sample_law",
            "law_num": "令和二年法律第一号",
            "law_title": "テスト法",
            "unique_anchor": "Main_Article_1",
            "anchor": "Mp-At_1",
            "content": "（目的）\n第一条　…",
            "article_summary": "（目的）",
            "era": "Reiwa",
            "year": 2,
            "law_type": "Act",
            "promulgate_date": "2020-04-01",
        }
        base.update(over)
        return base

    def test_column_order_and_count(self) -> None:
        t = ld._coerce_row(self._row())
        self.assertEqual(len(t), len(ld.STAGING_COLUMNS))
        # law_id, law_num, law_title, unique_anchor が先頭 4 つ。
        self.assertEqual(t[:4], ("sample_law", "令和二年法律第一号", "テスト法", "Main_Article_1"))

    def test_year_is_int_and_date_is_date(self) -> None:
        t = ld._coerce_row(self._row())
        self.assertEqual(t[8], 2)
        self.assertEqual(t[10], date(2020, 4, 1))

    def test_null_anchor_and_summary(self) -> None:
        # 附則条文（anchor=None）＋ article_summary 空文字 → どちらも None。
        t = ld._coerce_row(self._row(anchor=None, article_summary=""))
        self.assertIsNone(t[4])  # anchor
        self.assertIsNone(t[6])  # article_summary

    def test_missing_optional_keys_become_none(self) -> None:
        row = {
            "law_id": "x",
            "law_num": "n",
            "law_title": "t",
            "unique_anchor": "Suppl_Article_1",
            "content": "c",
        }
        t = ld._coerce_row(row)
        self.assertIsNone(t[4])   # anchor
        self.assertIsNone(t[7])   # era
        self.assertIsNone(t[8])   # year
        self.assertIsNone(t[9])   # law_type
        self.assertIsNone(t[10])  # promulgate_date


class IterJsonlRowsTest(unittest.TestCase):
    def test_reads_lines_and_skips_blanks(self) -> None:
        data = '{"law_id": "a"}\n\n{"law_id": "b"}\n'
        rows = list(ld.iter_jsonl_rows(io.StringIO(data)))
        self.assertEqual([r["law_id"] for r in rows], ["a", "b"])


if __name__ == "__main__":
    unittest.main()

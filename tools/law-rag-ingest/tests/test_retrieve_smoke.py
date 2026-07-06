"""retrieve_smoke の純関数検証（DB 不要・psycopg 不要・ネットワーク不要）。

実行: python3 -m unittest discover -s tools/law-rag-ingest/tests
  DB/TEI を伴う retrieve（run_self_retrieval / run_demo）は配布元環境で疎通確認する。
  RRF は src/lib/rag/rrf.ts と同式である点を、TS 実装と同じ期待値で固定する。
"""

import sys
import unittest
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL_ROOT))

import retrieve_smoke as rs  # noqa: E402  (psycopg / embed_fill の TEI は遅延 import）


class RrfTest(unittest.TestCase):
    def test_single_list_ranks_by_position(self) -> None:
        fused = rs.reciprocal_rank_fusion([["a", "b", "c"]], k=60, top_m=10)
        ids = [i for i, _ in fused]
        self.assertEqual(ids, ["a", "b", "c"])

    def test_contributions_add_across_lists(self) -> None:
        # a は両リストで rank1 → 2/(60+1)。b は list1 rank2 + list2 rank? なし。
        fused = rs.reciprocal_rank_fusion([["a", "b"], ["a", "c"]], k=60, top_m=10)
        scores = dict(fused)
        self.assertAlmostEqual(scores["a"], 2 / 61)
        self.assertAlmostEqual(scores["b"], 1 / 62)
        self.assertAlmostEqual(scores["c"], 1 / 62)
        self.assertEqual(fused[0][0], "a")  # 最高スコアは a

    def test_stable_tie_break_first_seen(self) -> None:
        # b と c 同点 → 先に現れた b が先。
        fused = rs.reciprocal_rank_fusion([["a", "b"], ["a", "c"]], k=60, top_m=10)
        ids = [i for i, _ in fused]
        self.assertEqual(ids, ["a", "b", "c"])

    def test_top_m_truncates(self) -> None:
        fused = rs.reciprocal_rank_fusion([["a", "b", "c", "d"]], k=60, top_m=2)
        self.assertEqual(len(fused), 2)

    def test_tuple_ids_supported(self) -> None:
        # 本用途の id は PK タプル。ハッシュ可能で動くこと。
        fused = rs.reciprocal_rank_fusion([[("L1", "a"), ("L2", "b")]], top_m=10)
        self.assertEqual(fused[0][0], ("L1", "a"))


class HitMrrTest(unittest.TestCase):
    def test_hit_at_k_true(self) -> None:
        self.assertEqual(rs.hit_at_k(["x", "t", "y"], "t", 3), 1)

    def test_hit_at_k_outside_k(self) -> None:
        self.assertEqual(rs.hit_at_k(["x", "y", "t"], "t", 2), 0)

    def test_mrr_average(self) -> None:
        # rank1(1.0) と rank2(0.5) → 平均 0.75。
        lists = [["t", "x"], ["y", "t"]]
        targets = ["t", "t"]
        self.assertAlmostEqual(rs.mrr(lists, targets), 0.75)

    def test_mrr_absent_target_zero(self) -> None:
        self.assertEqual(rs.mrr([["x", "y"]], ["t"]), 0.0)

    def test_mrr_empty(self) -> None:
        self.assertEqual(rs.mrr([], []), 0.0)


class BigmSqlTest(unittest.TestCase):
    def test_operator_percent_is_escaped_for_psycopg(self) -> None:
        # pg_bigm の `=%` は psycopg 用に `=%%`（doubled）でなければ "incomplete placeholder" で落ちる。
        sql = rs.bigm_search_sql()
        self.assertIn("=%% ", sql)
        self.assertNotIn("=% ", sql.replace("=%%", ""))  # 生の `=% ` が残っていない

    def test_has_three_placeholders(self) -> None:
        # bigm_similarity 引数 / WHERE 句 / LIMIT の 3 つ。エスケープ済 %% は除いて数える。
        sql = rs.bigm_search_sql().replace("%%", "")
        self.assertEqual(sql.count("%s"), 3)

    def test_uses_bigm_similarity_and_order(self) -> None:
        sql = rs.bigm_search_sql()
        self.assertIn("bigm_similarity", sql)
        self.assertIn("ORDER BY score DESC", sql)


class HelpersTest(unittest.TestCase):
    def test_snippet_truncates_with_ellipsis(self) -> None:
        self.assertEqual(rs.snippet("abcdef", 3), "abc…")

    def test_snippet_collapses_whitespace(self) -> None:
        self.assertEqual(rs.snippet("a  b\n c", 60), "a b c")

    def test_snippet_handles_none(self) -> None:
        self.assertEqual(rs.snippet(None), "")

    def test_pk_key_prefix(self) -> None:
        self.assertEqual(rs.pk_key(("num", "anchor", "score")), ("num", "anchor"))

    def test_defaults_match_production_rrf(self) -> None:
        # src/lib/rag/rrf.ts DEFAULT_RRF_OPTIONS と一致（k=60, topM=10）。
        self.assertEqual(rs.RRF_K, 60)
        self.assertEqual(rs.TOP_M, 10)


if __name__ == "__main__":
    unittest.main()

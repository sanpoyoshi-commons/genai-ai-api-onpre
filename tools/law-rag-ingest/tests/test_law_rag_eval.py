"""law_rag_eval の純関数検証（DB 不要・psycopg 不要・ネットワーク不要）。

実行: python3 -m unittest discover -s tools/law-rag-ingest/tests
  DB/TEI/reranker を伴う evaluate() は配布元環境（PostgreSQL + pgvector + TEI + tei-reranker）で実機確認する。
  TEI /rerank 契約は src/llm/adapters/teiRerankAdapter.ts と同一（{query, texts[]} → [{index, score}]）。
"""

import json
import sys
import unittest
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL_ROOT))

import law_rag_eval as lre  # noqa: E402


class RerankPayloadTest(unittest.TestCase):
    def test_build_payload_matches_tei_contract(self) -> None:
        self.assertEqual(
            json.loads(lre.build_rerank_payload("q", ["a", "b"])),
            {"query": "q", "texts": ["a", "b"]},
        )

    def test_parse_response(self) -> None:
        self.assertEqual(
            lre.parse_rerank_response(b'[{"index":2,"score":0.9},{"index":0,"score":0.1}]'),
            [(2, 0.9), (0, 0.1)],
        )

    def test_parse_rejects_non_list(self) -> None:
        with self.assertRaises(ValueError):
            lre.parse_rerank_response(b'{"index":0}')


class ReorderTest(unittest.TestCase):
    def test_reorders_by_ranked_index(self) -> None:
        cands = ["A", "B", "C"]
        ranked = [(2, 0.9), (0, 0.5), (1, 0.1)]
        self.assertEqual(lre.reorder_by_rerank(cands, ranked), ["C", "A", "B"])

    def test_out_of_range_index_dropped(self) -> None:
        cands = ["A", "B"]
        ranked = [(5, 0.9), (0, 0.5)]  # 5 は範囲外
        self.assertEqual(lre.reorder_by_rerank(cands, ranked), ["A", "B"])

    def test_missing_candidates_appended_in_order(self) -> None:
        # rerank が一部しか返さない異常時、残りは元順で末尾へ（取りこぼし防止）。
        cands = ["A", "B", "C"]
        ranked = [(1, 0.9)]
        self.assertEqual(lre.reorder_by_rerank(cands, ranked), ["B", "A", "C"])

    def test_duplicate_index_ignored(self) -> None:
        cands = ["A", "B"]
        ranked = [(0, 0.9), (0, 0.8), (1, 0.1)]
        self.assertEqual(lre.reorder_by_rerank(cands, ranked), ["A", "B"])


class NeedleHitTest(unittest.TestCase):
    def test_substring_present(self) -> None:
        self.assertTrue(lre.needle_hit("第三十二条 一週間について四十時間を超えて", "一週間について四十時間"))

    def test_whitespace_insensitive(self) -> None:
        # content 側に空白/改行が挟まっても needle がマッチする。
        self.assertTrue(lre.needle_hit("六箇月間　継続 勤務", "六箇月間継続勤務"))

    def test_absent(self) -> None:
        self.assertFalse(lre.needle_hit("無関係な条文", "一週間について四十時間"))

    def test_empty_inputs(self) -> None:
        self.assertFalse(lre.needle_hit(None, "x"))
        self.assertFalse(lre.needle_hit("x", ""))


class MetricsTest(unittest.TestCase):
    def test_hit_at_1(self) -> None:
        self.assertEqual(lre.metrics_from_relevance([True, False, False], 10), (1, 1, 1.0))

    def test_hit_at_k_not_first(self) -> None:
        # rank3 が正解 → hit@1=0, hit@10=1, rr=1/3。
        self.assertEqual(lre.metrics_from_relevance([False, False, True], 10), (0, 1, 1 / 3))

    def test_outside_k(self) -> None:
        rel = [False] * 10 + [True]  # rank11
        h1, hk, rr = lre.metrics_from_relevance(rel, 10)
        self.assertEqual((h1, hk), (0, 0))
        self.assertAlmostEqual(rr, 1 / 11)

    def test_no_hit(self) -> None:
        self.assertEqual(lre.metrics_from_relevance([False, False], 10), (0, 0, 0.0))

    def test_empty(self) -> None:
        self.assertEqual(lre.metrics_from_relevance([], 10), (0, 0, 0.0))


if __name__ == "__main__":
    unittest.main()

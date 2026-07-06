"""xml_to_jsonl の XML パース移植の妥当性検証（標準 unittest・依存なし）。

実行: python3 -m unittest discover -s tools/law-rag-ingest/tests
  （リポジトリルートから。または tools/law-rag-ingest/ で python3 -m unittest）
"""

import sys
import unittest
from pathlib import Path

# xml_to_jsonl をテストから import できるようにツールのルートを sys.path へ。
TOOL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL_ROOT))

import xml_to_jsonl as x  # noqa: E402

FIXTURE = TOOL_ROOT / "tests" / "fixtures" / "sample_law.xml"


class ParseLawXmlTest(unittest.TestCase):
    def setUp(self) -> None:
        self.chunks = x.parse_law_xml(FIXTURE)
        self.anchors = {c["unique_anchor"] for c in self.chunks}

    def test_chunk_count_excludes_deleted_and_amend_suppl(self) -> None:
        # 本則 第1条/第3条 ＋ 原始附則 第1条 = 3。Delete=true(第2条)・範囲削除 stub(第4:5条)・改正附則は除外。
        self.assertEqual(len(self.chunks), 3)

    def test_anchors(self) -> None:
        self.assertEqual(
            self.anchors,
            {"Main_Article_1", "Main_Article_3", "Suppl_Article_1"},
        )

    def test_deleted_article_excluded(self) -> None:
        self.assertNotIn("Main_Article_2", self.anchors)

    def test_range_deletion_stub_excluded(self) -> None:
        # 本文が「削除」だけの範囲削除条文（Delete 属性なし）は取り込まない（所見 B）。
        self.assertNotIn("Main_Article_4:5", self.anchors)

    def test_law_title_and_num(self) -> None:
        for c in self.chunks:
            self.assertEqual(c["law_title"], "テスト法")
            self.assertEqual(c["law_num"], "令和二年法律第一号")

    def test_egov_anchor_main_only(self) -> None:
        main1 = next(c for c in self.chunks if c["unique_anchor"] == "Main_Article_1")
        suppl1 = next(c for c in self.chunks if c["unique_anchor"] == "Suppl_Article_1")
        self.assertEqual(main1["anchor"], "Mp-At_1")
        self.assertIsNone(suppl1["anchor"])

    def test_article_summary_prefers_caption(self) -> None:
        main1 = next(c for c in self.chunks if c["unique_anchor"] == "Main_Article_1")
        self.assertEqual(main1["article_summary"], "（目的）")

    def test_content_contains_item_text(self) -> None:
        main3 = next(c for c in self.chunks if c["unique_anchor"] == "Main_Article_3")
        self.assertIn("テストとは検証をいう。", main3["content"])
        self.assertIn("（定義）", main3["content"])


class ProcessFileTest(unittest.TestCase):
    def test_metadata_and_era_conversion(self) -> None:
        rows, _ = x.process_file(str(FIXTURE))
        self.assertEqual(len(rows), 3)
        row = rows[0]
        self.assertEqual(row["law_id"], "sample_law")
        self.assertEqual(row["era"], "Reiwa")
        self.assertEqual(row["year"], 2)
        self.assertEqual(row["law_type"], "Act")
        # Reiwa(2018 起点) + 2 = 2020-04-01
        self.assertEqual(row["promulgate_date"], "2020-04-01")

    def test_eleven_columns(self) -> None:
        rows, _ = x.process_file(str(FIXTURE))
        expected = {
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
        }
        self.assertEqual(set(rows[0].keys()), expected)


class IsDeletionStubTest(unittest.TestCase):
    def test_single_article_deletion(self) -> None:
        self.assertTrue(x.is_deletion_stub("第五十条\n　　削除"))

    def test_range_deletion(self) -> None:
        self.assertTrue(x.is_deletion_stub("第五条及び第六条\n　　削除"))

    def test_content_only_sakujo(self) -> None:
        # タイトル行が無く本文だけ「削除」のケースも拾う。
        self.assertTrue(x.is_deletion_stub("削除"))

    def test_real_article_with_sakujo_word_kept(self) -> None:
        # 本文に「削除」を含むだけの正当条文は除外しない。
        self.assertFalse(x.is_deletion_stub("第一条\n　　前条の規定を削除し、新たに次条を加える。"))

    def test_normal_article_kept(self) -> None:
        self.assertFalse(x.is_deletion_stub("第一条\n　　この法律は、テストを目的とする。"))


if __name__ == "__main__":
    unittest.main()

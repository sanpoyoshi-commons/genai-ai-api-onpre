"""xml_to_jsonl の XML パース移植の妥当性検証（標準 unittest・依存なし）。

実行: python3 -m unittest discover -s tools/law-rag-ingest/tests
  （リポジトリルートから。または tools/law-rag-ingest/ で python3 -m unittest）
"""

import io
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

    def test_no_main_provision_chunk_when_articles_exist(self) -> None:
        # 条のある本則は従来どおり条ごとのチャンクだけ。
        self.assertNotIn("Main_Provision", self.anchors)


def _law_xml(main_provision: str, suppl_provision: str = "") -> io.BytesIO:
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Law Era="Showa" Year="22" LawType="CabinetOrder" PromulgateMonth="5" PromulgateDay="3">
  <LawNum>昭和二十二年政令第一号</LawNum>
  <LawBody>
    <LawTitle>テスト令</LawTitle>
    <MainProvision>{main_provision}</MainProvision>
    {suppl_provision}
  </LawBody>
</Law>"""
    return io.BytesIO(xml.encode("utf-8"))


class MainProvisionWithoutArticlesTest(unittest.TestCase):
    def test_paragraph_with_items_becomes_one_chunk(self) -> None:
        chunks = x.parse_law_xml(
            _law_xml(
                """
      <Paragraph Num="1">
        <ParagraphNum/>
        <ParagraphSentence><Sentence>次に掲げる者を指定する。</Sentence></ParagraphSentence>
        <Item Num="1">
          <ItemTitle>一</ItemTitle>
          <ItemSentence><Sentence>甲</Sentence></ItemSentence>
        </Item>
        <Item Num="2">
          <ItemTitle>二</ItemTitle>
          <ItemSentence><Sentence>乙</Sentence></ItemSentence>
        </Item>
      </Paragraph>"""
            )
        )
        self.assertEqual(len(chunks), 1)
        chunk = chunks[0]
        self.assertEqual(chunk["unique_anchor"], "Main_Provision")
        self.assertIsNone(chunk["anchor"])
        self.assertEqual(chunk["article_summary"], "本則")
        self.assertEqual(chunk["law_title"], "テスト令")
        self.assertEqual(chunk["law_num"], "昭和二十二年政令第一号")
        self.assertEqual(
            chunk["content"],
            "本則\n　　次に掲げる者を指定する。\n　　一　甲\n　　二　乙",
        )

    def test_articles_only_in_original_supplementary_provision(self) -> None:
        chunks = x.parse_law_xml(
            _law_xml(
                """
      <Paragraph Num="1">
        <ParagraphNum/>
        <ParagraphSentence><Sentence>本令は、テストのために定める。</Sentence></ParagraphSentence>
      </Paragraph>""",
                """
    <SupplProvision>
      <Article Num="1">
        <ArticleTitle>第一条</ArticleTitle>
        <Paragraph Num="1">
          <ParagraphNum/>
          <ParagraphSentence><Sentence>この政令は、公布の日から施行する。</Sentence></ParagraphSentence>
        </Paragraph>
      </Article>
    </SupplProvision>""",
            )
        )
        self.assertEqual(
            [c["unique_anchor"] for c in chunks],
            ["Main_Provision", "Suppl_Article_1"],
        )

    def test_blank_paragraph_makes_no_chunk(self) -> None:
        # 未施行の版で本則が空の項 1 つだけになっているもの。
        chunks = x.parse_law_xml(
            _law_xml(
                """
      <Paragraph Num="1">
        <ParagraphNum/>
        <ParagraphSentence><Sentence/></ParagraphSentence>
      </Paragraph>"""
            )
        )
        self.assertEqual(chunks, [])

    def test_deletion_only_makes_no_chunk(self) -> None:
        chunks = x.parse_law_xml(
            _law_xml(
                """
      <Paragraph Num="1">
        <ParagraphNum/>
        <ParagraphSentence><Sentence>削除</Sentence></ParagraphSentence>
      </Paragraph>"""
            )
        )
        self.assertEqual(chunks, [])


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

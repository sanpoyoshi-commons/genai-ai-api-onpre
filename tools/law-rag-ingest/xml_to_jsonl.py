"""e-Gov 法令標準 XML を JSONL（1 行 1 条文チャンク）へ変換する配布元ビルド時ツール。

法令 RAG のデータ取り込みパイプライン。
e-Gov bulk download の XML 群を走査し、条（Article）単位のチャンクを 11 カラムの JSONL に書き出す。
出力 JSONL は後段で PostgreSQL の dwh_laws（DWH 層）へ COPY/INSERT する（DB 投入は別ツール・schema 確定後）。

由来（attribution）:
    Derived from Digital Agency of Japan's `lawsy-custom-bq/preprocess/load_to_bq.py`
    (MIT License, Copyright (c) 2026 Digital Agency of Japan).
    GCS / BigQuery I/O is removed; XML parsing logic (parse_law_xml / format_article_text)
    is ported as-is for local PostgreSQL ingest. See LICENSES-THIRD-PARTY for the MIT notice.

使い方:
    python3 xml_to_jsonl.py <source_dir> [-o OUTPUT.jsonl] [-j JOBS]
    -o 省略時は標準出力へ。<source_dir> 配下の *.xml を再帰的に処理する。
"""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

# 元号 → 西暦の起点（この値に Year を加算する）。
ERA_BASE = {
    "Meiji": 1867,
    "Taisho": 1911,
    "Showa": 1925,
    "Heisei": 1988,
    "Reiwa": 2018,
}

# format_article_text のインデント階層。構造ノードの入れ子レベルを全角スペース数に対応させる。
INDENT_MAP = {
    "Article": 0,
    "Paragraph": 1,
    "Item": 2,
    "Subitem1": 3,
    "Subitem2": 4,
    "Subitem3": 5,
    "Subitem4": 6,
    "Subitem5": 7,
    "Subitem6": 8,
    "Subitem7": 9,
    "Subitem8": 10,
    "Subitem9": 11,
    "Subitem10": 12,
    "List": 2,
    "Table": 2,
}

TITLE_TAGS = [f"Subitem{i}Title" for i in range(1, 11)] + [
    "ArticleCaption",
    "ArticleTitle",
    "ParagraphNum",
    "ItemTitle",
]
SENTENCE_TAGS = [f"Subitem{i}Sentence" for i in range(1, 11)] + [
    "ParagraphSentence",
    "ItemSentence",
]


def get_raw_text(element: ET.Element | None) -> str:
    """要素配下の全テキストを連結して trim する。"""
    if element is None:
        return ""
    return "".join(element.itertext()).strip()


def format_article_text(article_element: ET.Element | None) -> str:
    """条（Article）の階層構造を全角スペースインデントの整形テキストへ平坦化する。"""
    if article_element is None:
        return ""

    lines: list[str] = []

    def get_full_text(element: ET.Element | None) -> str:
        if element is None:
            return ""
        return "".join(element.itertext()).strip()

    def recursive_format(element: ET.Element, level: int) -> None:
        is_structural_node = element.tag in INDENT_MAP
        if is_structural_node:
            title_elements = [el for el in element if el.tag in TITLE_TAGS]
            sentence_elements = [el for el in element if el.tag in SENTENCE_TAGS]

            parts = [get_full_text(el) for el in title_elements]
            parts += [get_full_text(el) for el in sentence_elements]

            if parts:
                lines.append("　" * level + "　".join(parts))

        child_level = level + 1 if is_structural_node else level

        for child in element:
            if child.tag in TITLE_TAGS or child.tag in SENTENCE_TAGS:
                continue
            if child.tag not in INDENT_MAP:
                child_text = get_full_text(child)
                if child_text:
                    lines.append("　" * child_level + child_text)
            else:
                recursive_format(child, child_level)

    recursive_format(article_element, 0)
    return "\n".join(lines)


def is_deletion_stub(content: str) -> bool:
    """範囲削除・単条削除の「中身が削除だけ」の条文か判定する（取り込み除外対象）。

    e-Gov 標準 XML では、削除済み条文の一部は `Delete="true"` 属性ではなく、本文 Sentence が
    「削除」だけの通常 Article として現れる（例: ArticleTitle「第五条及び第六条」＋ ParagraphSentence
    「削除」＝範囲削除）。format_article_text の出力はタイトル行＋本文行なので、**先頭（タイトル）行を
    除いた本文を trim して「削除」だけなら削除 stub** とみなす。本文に「削除」を含むだけの正当な条文は
    本文全体が「削除」と一致しないため誤除外しない（実データ 255,680 行で偽陽性 0・本文に削除を含む正当
    条文 568 件は保持を確認済）。空白は全角・半角・改行・タブを吸収する。
    """
    body = content.split("\n", 1)[1] if "\n" in content else content
    return body.strip("　 \n\t") == "削除"


def parse_law_xml(xml_file: str | Path) -> list[dict[str, str | None]]:
    """法令 XML を条（Article）単位のチャンク辞書のリストへ変換する。

    本則（MainProvision）＋原始附則（AmendLawNum 属性なしの SupplProvision）のみを対象とし、
    廃止条文（Delete="true"）・改正附則（AmendLawNum 付き SupplProvision）・**削除 stub（本文が
    「削除」だけの範囲/単条削除条文・is_deletion_stub）** は除外する。削除 stub は検索ノイズに
    なるだけで法令内容を持たないため取り込まない（所見 B 対処）。
    """
    tree = ET.parse(xml_file)
    root = tree.getroot()

    law_title = get_raw_text(root.find(".//LawTitle"))
    law_num = get_raw_text(root.find(".//LawNum"))

    chunks: list[dict[str, str | None]] = []

    def process_article(article: ET.Element, provision_prefix: str) -> None:
        if article.get("Delete") == "true":
            return

        article_num = article.get("Num")
        unique_anchor = f"{provision_prefix}_Article_{article_num}"

        # e-Gov リンク用アンカーは本則のみ（附則は e-Gov のアンカー体系が異なるため None）。
        egov_anchor = f"Mp-At_{article_num}" if provision_prefix == "Main" else None

        content = format_article_text(article)
        # 本文が「削除」だけの削除 stub（範囲/単条削除）は取り込まない（検索ノイズ・所見 B）。
        if is_deletion_stub(content):
            return
        article_caption = get_raw_text(article.find("ArticleCaption"))
        first_paragraph = article.find(".//Paragraph")
        first_paragraph_text = (
            get_raw_text(first_paragraph.find(".//ParagraphSentence"))
            if first_paragraph is not None
            else ""
        )
        article_summary = article_caption or first_paragraph_text

        chunks.append(
            {
                "law_num": law_num,
                "law_title": law_title,
                "unique_anchor": unique_anchor,
                "anchor": egov_anchor,
                "content": content,
                "article_summary": article_summary,
            }
        )

    # 1. 本則
    for article in root.findall(".//MainProvision//Article"):
        process_article(article, "Main")

    # 2. 原始附則（改正附則 AmendLawNum は除外）
    for suppl_provision in root.findall(".//SupplProvision"):
        if "AmendLawNum" in suppl_provision.attrib:
            continue
        for article in suppl_provision.findall(".//Article"):
            process_article(article, "Suppl")

    return chunks


def _to_gregorian_year(era: str | None, year: int) -> int:
    """元号と元号年から西暦年を求める。未知の元号はそのまま年を返す。"""
    base = ERA_BASE.get(era or "")
    return base + year if base is not None else year


def process_file(file_path: str) -> tuple[list[dict[str, object]], str]:
    """1 つの法令 XML から DWH 層 11 カラムの行リストを生成する（ProcessPool 実行単位）。"""
    try:
        law_id = Path(file_path).stem
        tree = ET.parse(file_path)
        xml_root = tree.getroot()

        era = xml_root.get("Era")
        year_str = xml_root.get("Year")
        year = int(year_str) if year_str and year_str.isdigit() else 0

        law_type = xml_root.get("LawType")
        month_str = xml_root.get("PromulgateMonth")
        day_str = xml_root.get("PromulgateDay")
        month = int(month_str) if month_str and month_str.isdigit() else 1
        day = int(day_str) if day_str and day_str.isdigit() else 1

        gregorian_year = _to_gregorian_year(era, year)
        promulgate_date = f"{gregorian_year:04d}-{month:02d}-{day:02d}"

        rows = [
            {
                "law_id": law_id,
                "law_num": chunk["law_num"],
                "law_title": chunk["law_title"],
                "unique_anchor": chunk["unique_anchor"],
                "anchor": chunk["anchor"],
                "content": chunk["content"],
                "article_summary": chunk["article_summary"],
                "era": era,
                "year": year,
                "law_type": law_type,
                "promulgate_date": promulgate_date,
            }
            for chunk in parse_law_xml(file_path)
        ]
        return rows, file_path
    except Exception as e:  # noqa: BLE001 - 1 ファイルの失敗で全体を止めない
        print(f"ERROR: failed to process {file_path}: {e}", file=sys.stderr)
        return [], file_path


def iter_xml_files(source_dir: str | Path) -> Iterator[str]:
    """source_dir 配下の *.xml を再帰的に列挙する。"""
    for path in sorted(Path(source_dir).rglob("*.xml")):
        yield str(path)


def convert(source_dir: str | Path, out, jobs: int | None = None) -> int:
    """source_dir の法令 XML を JSONL として out へ書き出す。書き出した行数を返す。"""
    files = list(iter_xml_files(source_dir))
    if not files:
        print(f"INFO: no .xml files under {source_dir}", file=sys.stderr)
        return 0

    total_rows = 0
    done = 0
    with ProcessPoolExecutor(max_workers=jobs) as executor:
        futures = {executor.submit(process_file, f): f for f in files}
        for future in as_completed(futures):
            rows, _ = future.result()
            for row in rows:
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                total_rows += 1
            done += 1
            if done % 500 == 0:
                print(f"INFO: {done}/{len(files)} files, {total_rows} rows", file=sys.stderr)

    print(f"INFO: done. {len(files)} files, {total_rows} rows", file=sys.stderr)
    return total_rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="e-Gov law XML -> JSONL (law RAG).")
    parser.add_argument("source_dir", help="root directory containing e-Gov law *.xml files")
    parser.add_argument(
        "-o",
        "--output",
        help="output JSONL path (default: stdout)",
        default=None,
    )
    parser.add_argument(
        "-j",
        "--jobs",
        type=int,
        default=None,
        help="parallel worker processes (default: number of CPUs)",
    )
    args = parser.parse_args(argv)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            convert(args.source_dir, f, args.jobs)
    else:
        convert(args.source_dir, sys.stdout, args.jobs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

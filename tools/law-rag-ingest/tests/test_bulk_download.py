"""bulk_download の zip 展開・サイズ整形の検証（ネットワーク不要・DB 不要）。

実行: python3 -m unittest discover -s tools/law-rag-ingest/tests
  download()（ネットワーク I/O）は対象外。展開ロジックと安全性のみ検証する。
"""

import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL_ROOT))

import bulk_download as bd  # noqa: E402


class HumanSizeTest(unittest.TestCase):
    def test_units(self) -> None:
        self.assertEqual(bd.human_size(512), "512.0B")
        self.assertEqual(bd.human_size(1536), "1.5KiB")
        self.assertEqual(bd.human_size(278 * 1024 * 1024), "278.0MiB")


class ExtractXmlTest(unittest.TestCase):
    def _make_zip(self, zip_path: Path, entries: dict[str, bytes]) -> None:
        with zipfile.ZipFile(zip_path, "w") as zf:
            for name, data in entries.items():
                zf.writestr(name, data)

    def test_extracts_only_xml_and_preserves_structure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "bulk.zip"
            self._make_zip(
                zip_path,
                {
                    "100AC0000000001/100AC0000000001.xml": b"<Law/>",
                    "200AC0000000002/200AC0000000002.xml": b"<Law/>",
                    "README.txt": b"not xml",
                },
            )
            dest = tmp_path / "out"
            count = bd.extract_xml(zip_path, dest)
            self.assertEqual(count, 2)
            self.assertTrue((dest / "100AC0000000001" / "100AC0000000001.xml").exists())
            self.assertFalse((dest / "README.txt").exists())

    def test_rejects_zip_slip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "evil.zip"
            # `..` を含む悪意あるパスは展開せずスキップする。
            self._make_zip(zip_path, {"../escape.xml": b"<Law/>"})
            dest = tmp_path / "out"
            count = bd.extract_xml(zip_path, dest)
            self.assertEqual(count, 0)
            self.assertFalse((tmp_path / "escape.xml").exists())


if __name__ == "__main__":
    unittest.main()

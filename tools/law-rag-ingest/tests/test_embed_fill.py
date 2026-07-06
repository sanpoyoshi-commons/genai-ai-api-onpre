"""embed_fill の純関数 + TEI 呼び出しの adaptive 分割の検証（DB 不要・psycopg 不要・ネットワーク不要）。

実行: python3 -m unittest discover -s tools/law-rag-ingest/tests
  DB 接続を伴う fill_target() は配布元環境（PostgreSQL 16 + pgvector + TEI/ruri-768）で疎通確認する。
"""

import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path

# embed_fill をテストから import できるようにツールのルートを sys.path へ。
TOOL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL_ROOT))

import embed_fill as ef  # noqa: E402  (psycopg は fill_target 内で遅延 import のため import 安全)


class ToPgvectorTest(unittest.TestCase):
    def test_formats_as_pgvector_literal(self) -> None:
        self.assertEqual(ef.to_pgvector([0.1, 0.2, 3]), "[0.1,0.2,3.0]")

    def test_empty(self) -> None:
        self.assertEqual(ef.to_pgvector([]), "[]")


class BatchedTest(unittest.TestCase):
    def test_splits_into_chunks(self) -> None:
        self.assertEqual([len(b) for b in ef.batched(list(range(20)), 8)], [8, 8, 4])

    def test_exact_multiple(self) -> None:
        self.assertEqual(list(ef.batched([1, 2, 3, 4], 2)), [[1, 2], [3, 4]])

    def test_rejects_zero_size(self) -> None:
        with self.assertRaises(ValueError):
            list(ef.batched([1], 0))


class PayloadTest(unittest.TestCase):
    def test_build_embed_payload(self) -> None:
        self.assertEqual(
            json.loads(ef.build_embed_payload(["a", "b"])),
            {"inputs": ["a", "b"], "truncate": True},
        )

    def test_build_embed_payload_truncate_false(self) -> None:
        self.assertFalse(json.loads(ef.build_embed_payload(["a"], truncate=False))["truncate"])

    def test_parse_embed_response(self) -> None:
        self.assertEqual(ef.parse_embed_response(b"[[1,2],[3,4]]"), [[1.0, 2.0], [3.0, 4.0]])

    def test_parse_embed_response_rejects_non_list(self) -> None:
        with self.assertRaises(ValueError):
            ef.parse_embed_response(b'{"x": 1}')


class _FakeResp:
    """urlopen の戻り（コンテキストマネージャ + read()）を模す。"""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self):  # noqa: ANN204
        return self

    def __exit__(self, *exc) -> bool:  # noqa: ANN002
        return False

    def read(self) -> bytes:
        return self._body


class EmbedTextsAdaptiveSplitTest(unittest.TestCase):
    """TEI が max-batch-tokens 超過で 422 を返したとき、半分割して再試行することを検証。"""

    def setUp(self) -> None:
        self._orig = ef.urllib.request.urlopen

    def tearDown(self) -> None:
        ef.urllib.request.urlopen = self._orig

    def _install(self, *, reject_above: int) -> None:
        """入力件数 > reject_above なら 422 を投げ、それ以下なら 1 件 = [count*1.0, …] を返す擬似 TEI。"""

        def fake_urlopen(req, timeout=None):  # noqa: ANN001
            inputs = json.loads(req.data)["inputs"]
            if len(inputs) > reject_above:
                raise urllib.error.HTTPError(
                    req.full_url, 422, "Unprocessable Entity", {}, io.BytesIO(b"batch too large")
                )
            # 各入力をその長さの 1 次元ベクトル相当（順序検証のため入力文字列を value に埋める）。
            vecs = [[float(len(t))] for t in inputs]
            return _FakeResp(json.dumps(vecs).encode())

        ef.urllib.request.urlopen = fake_urlopen

    def test_splits_until_accepted_and_preserves_order(self) -> None:
        self._install(reject_above=2)  # 1 リクエスト最大 2 件まで受理
        texts = ["a", "bb", "ccc", "dddd", "eeeee"]  # 5 件 → 422 → 半分割で吸収
        out = ef.embed_texts(texts, "http://tei:80")
        self.assertEqual(out, [[1.0], [2.0], [3.0], [4.0], [5.0]])  # 件数・順序保存

    def test_single_input_failure_raises(self) -> None:
        self._install(reject_above=0)  # 1 件でも拒否 → これ以上分割できず RuntimeError
        with self.assertRaises(RuntimeError):
            ef.embed_texts(["x"], "http://tei:80")

    def test_empty_returns_empty(self) -> None:
        self.assertEqual(ef.embed_texts([], "http://tei:80"), [])


if __name__ == "__main__":
    unittest.main()

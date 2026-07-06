"""e-Gov 法令データの一括ダウンロード zip を取得し、法令 XML を展開する配布元ビルド時ヘルパ。

法令 RAG。取得した XML ディレクトリを後段 `xml_to_jsonl.py` の入力にする。

    bulk_download.py → <dest>/**/*.xml → xml_to_jsonl.py → load_to_db.py

設計方針（不可侵ライン②・全件ループ禁止）:
    配布元（dump ビルド側）が **一括ダウンロード zip を 1 回取得**する用途のみ。利用者環境では走らせない
    （利用者は事前ビルド済み DB dump を使う）。法令 API への全件ループ取得はしない（差分のみ API v2・別途）。

【要確認】ダウンロード URL:
    e-Gov 法令データ一括ダウンロードのトップは https://laws.e-gov.go.jp/bulkdownload/ だが、
    全件 zip への**直接 URL は e-Gov 側の更新で変わりうるため本ツールに固定値を持たない**（裏取り未了）。
    実行時に `--url` で現行の zip URL を明示すること（運用環境で e-Gov のページから確認）。
    URL 既定値は持たせていない（推測 URL を事実として埋め込まない）。

依存: 標準ライブラリのみ（urllib / zipfile）。
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
import zipfile
from pathlib import Path


def human_size(num_bytes: float) -> str:
    """バイト数を人間可読な単位へ。"""
    size = float(num_bytes)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024 or unit == "TiB":
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}TiB"  # 到達しないが型のため


def download(url: str, dest_zip: Path, chunk_size: int = 1 << 20) -> Path:
    """url を dest_zip へストリーミング保存し、進捗を stderr に出す。保存先パスを返す。"""
    dest_zip.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "law-rag-ingest/0.1 (build-time)"})
    with urllib.request.urlopen(req) as resp:  # noqa: S310 - URL は実行時に運用者が明示
        total_str = resp.headers.get("Content-Length")
        total = int(total_str) if total_str and total_str.isdigit() else None
        downloaded = 0
        with open(dest_zip, "wb") as f:
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded / total * 100
                    print(
                        f"\rINFO: {human_size(downloaded)}/{human_size(total)} ({pct:.1f}%)",
                        end="",
                        file=sys.stderr,
                    )
                else:
                    print(f"\rINFO: {human_size(downloaded)}", end="", file=sys.stderr)
    print(f"\nINFO: saved {dest_zip}", file=sys.stderr)
    return dest_zip


def extract_xml(zip_path: Path, dest_dir: Path) -> int:
    """zip 内の *.xml を dest_dir へ展開（ディレクトリ構造を保持）。展開した XML 数を返す。

    XML 以外（README 等）は展開しない。zip スリップ（`..` / 絶対パス）を防ぐため正規化して検証する。
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_root = dest_dir.resolve()
    count = 0
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".xml"):
                continue
            out_path = (dest_dir / info.filename).resolve()
            if not out_path.is_relative_to(dest_root):
                print(f"WARN: skip unsafe path in zip: {info.filename}", file=sys.stderr)
                continue
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(out_path, "wb") as dst:
                dst.write(src.read())
            count += 1
    print(f"INFO: extracted {count} XML files to {dest_dir}", file=sys.stderr)
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Download e-Gov bulk law zip and extract XML (law RAG, build-time)."
    )
    parser.add_argument(
        "--url",
        required=True,
        help="e-Gov bulk-download zip URL（現行 URL を https://laws.e-gov.go.jp/bulkdownload/ で確認）",
    )
    parser.add_argument(
        "--dest",
        type=Path,
        default=Path("egov_xml"),
        help="directory to extract XML into (default: ./egov_xml)",
    )
    parser.add_argument(
        "--zip",
        type=Path,
        default=Path("egov_bulk.zip"),
        help="path to save (or reuse) the downloaded zip (default: ./egov_bulk.zip)",
    )
    parser.add_argument(
        "--no-extract",
        action="store_true",
        help="download only, skip extraction",
    )
    parser.add_argument(
        "--reuse-zip",
        action="store_true",
        help="skip download if the zip already exists",
    )
    args = parser.parse_args(argv)

    if args.reuse_zip and args.zip.exists():
        print(f"INFO: reusing existing zip {args.zip}", file=sys.stderr)
    else:
        download(args.url, args.zip)

    if not args.no_extract:
        extract_xml(args.zip, args.dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

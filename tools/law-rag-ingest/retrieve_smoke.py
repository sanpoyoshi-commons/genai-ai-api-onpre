"""法令 RAG retrieve の live 疎通（pgvector + pg_bigm + RRF）— 法令 RAG ②。

目的（何を確かめ、何を確かめないか・三分離）:
  - 【確かめる＝事実として測れる】retrieve パイプラインが end-to-end で動くこと:
    クエリ embedding（TEI/ruri-768）→ ベクトル検索（content_embedding <=> q）＋
    全文検索（pg_bigm: content =% q）→ RRF 融合（k=60, topM=10）→ 条文を返す。
    客観指標は **self-retrieval**：サンプル条文の content をクエリにして、その条文自身が
    top-k に返るか（Hit@1 / Hit@10 / MRR）。パイプラインの健全性を捏造ラベルなしで測れる。
  - 【確かめない＝本スクリプトの範囲外】法令ドメインの検索“正答率”。
    代表クエリ（--demo）は top-k を**目視疎通**のために表示するだけで、関連度ラベルは付けない
    （正答ラベルを置けば恣意になる＝無知の知）。本格的な法令 Hit/MRR は別途ラベル付き eval が要る。

本番との一致（src/lib/rag と同式）:
  - vector: `1 - (content_embedding <=> q)` を score、`ORDER BY content_embedding <=> q LIMIT k`（cosine）。
  - bigm:   `SET LOCAL pg_bigm.similarity_limit`、`bigm_similarity(content, q)`、`WHERE content =% q`、
            `ORDER BY score DESC LIMIT k`。
  - RRF:    `1/(k+rank)` 加算・rank 1 起点・topM、rrf.ts と同式（独自 TS 実装を Python で再現）。
  法令テーブルは owner なし（汎用 rag_* は owner スコープ）＝WHERE owner 条件は無い点だけが差。

由来（attribution）:
  法令 RAG は Digital Agency of Japan の lawsy-custom-bq（MIT License）を pgvector へ移植したもの。

使い方（libpq env: PGHOST/PGUSER/PGPASSWORD/PGDATABASE + TEI_URL で接続）:
  python3 retrieve_smoke.py                       # self-retrieval 30 件 + 代表クエリ目視
  python3 retrieve_smoke.py --samples 100 --k 10
  python3 retrieve_smoke.py --demo-only          # 代表クエリ目視だけ
  python3 retrieve_smoke.py --self-only          # self-retrieval Hit/MRR だけ

注意:
  psycopg（v3）が必要。RRF・正規化など純関数は psycopg / ネットワークなしで import・テスト可能に
  分離し、psycopg と TEI 呼び出しは実際に使う関数の中で行う。embed_fill.embed_texts を再利用する。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Sequence

# embed_fill の TEI 呼び出しを再利用（同一 TEI/ruri-768 で ingest と揃える）。
TOOL_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL_ROOT))
import embed_fill as ef  # noqa: E402

TABLE = "app_laws_for_indexing"
EMB_COL = "content_embedding"
TEXT_COL = "content"
PK_COLS = ("law_num", "unique_anchor")
DISTANCE = "<=>"

# RRF 既定（src/lib/rag/rrf.ts DEFAULT_RRF_OPTIONS と一致）。
RRF_K = 60
TOP_M = 10
# 各リストの取得件数（fetchK）。融合前に広めに取る（本番 config 相当）。
FETCH_K = 30
# pg_bigm 類似度下限（src/lib/rag/config.ts 既定 0.2＝recall 重視）。
BIGM_SIMILARITY_LIMIT = 0.2


# ---- 純関数（psycopg / ネットワーク不要・ユニットテスト対象） ----------------------------


def reciprocal_rank_fusion(
    lists: Sequence[Sequence[Any]], *, k: int = RRF_K, top_m: int = TOP_M
) -> list[tuple[Any, float]]:
    """順位付きリスト群を RRF 融合し [(id, score)] を score 降順 top_m で返す（rrf.ts と同式）。

    各リストは順位順（先頭 rank=1）。同一 id の寄与は加算。同点は最初に出現した順を保つ安定ソート。
    id はハッシュ可能であること（本用途では PK タプル）。
    """
    scores: dict[Any, float] = {}
    first_seen: dict[Any, int] = {}
    order = 0
    for lst in lists:
        for i, _id in enumerate(lst):
            rank = i + 1
            scores[_id] = scores.get(_id, 0.0) + 1.0 / (k + rank)
            if _id not in first_seen:
                first_seen[_id] = order
                order += 1
    fused = sorted(scores.items(), key=lambda kv: (-kv[1], first_seen[kv[0]]))
    return fused[:top_m]


def hit_at_k(ranked: Sequence[Any], target: Any, k: int) -> int:
    """target が ranked の top-k に居れば 1、居なければ 0。"""
    return 1 if target in list(ranked)[:k] else 0


def mrr(ranked_lists: Sequence[Sequence[Any]], targets: Sequence[Any]) -> float:
    """各 (ranked, target) の逆順位 1/rank の平均（Mean Reciprocal Rank）。target 不在は 0。"""
    if not ranked_lists:
        return 0.0
    total = 0.0
    for ranked, target in zip(ranked_lists, targets):
        for i, item in enumerate(ranked):
            if item == target:
                total += 1.0 / (i + 1)
                break
    return total / len(ranked_lists)


def bigm_search_sql() -> str:
    """pg_bigm 全文検索 SQL（psycopg 用・演算子 `=%` は `%%` エスケープ済）。

    psycopg は `%` をプレースホルダ開始と解釈するため、pg_bigm 演算子 `=%` の `%` を `%%` にする
    （psycopg が `%%`→`%` に戻して SQL に渡す）。プレースホルダは bigm_similarity 引数・WHERE 句・LIMIT の 3 つ。
    """
    pk_select = ", ".join(PK_COLS)
    return (
        f"SELECT {pk_select}, bigm_similarity({TEXT_COL}, %s) AS score FROM {TABLE} "
        f"WHERE {TEXT_COL} =%% %s "
        f"ORDER BY score DESC LIMIT %s"
    )


def snippet(text: str, n: int = 60) -> str:
    """ログ表示用に本文を 1 行・n 文字に丸める。"""
    s = " ".join((text or "").split())
    return s[:n] + ("…" if len(s) > n else "")


def pk_key(row: Sequence[Any]) -> tuple:
    return tuple(row[: len(PK_COLS)])


# ---- DB / TEI（遅延 import） ------------------------------------------------------------


def _vec_literal(vec: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


def _vector_search(cur, q_vec_lit: str, k: int) -> list[tuple]:
    pk_select = ", ".join(PK_COLS)
    cur.execute(
        f"SELECT {pk_select} FROM {TABLE} "
        f"WHERE {EMB_COL} IS NOT NULL "
        f"ORDER BY {EMB_COL} {DISTANCE} %s::vector LIMIT %s",
        (q_vec_lit, k),
    )
    return [pk_key(r) for r in cur.fetchall()]


def _bigm_search(cur, q_text: str, k: int, similarity_limit: float) -> list[tuple]:
    # similarity_limit は config 由来の数値（ユーザ入力でない）。float 強制で安全に SET LOCAL。
    cur.execute(f"SET LOCAL pg_bigm.similarity_limit = {float(similarity_limit)}")
    cur.execute(bigm_search_sql(), (q_text, q_text, k))
    return [pk_key(r) for r in cur.fetchall()]


def _fetch_rows_for_display(cur, pks: Sequence[tuple]) -> dict[tuple, tuple]:
    """PK 群について (law_num, unique_anchor) → (law_title?, content) を引く（表示用）。

    law_title は app_laws_master 由来。content は本テーブル。表示専用なので 1 件ずつでも十分。
    """
    out: dict[tuple, tuple] = {}
    pk_where = " AND ".join(f"a.{c} = %s" for c in PK_COLS)
    for pk in pks:
        cur.execute(
            f"SELECT m.law_title, a.{TEXT_COL} FROM {TABLE} a "
            f"LEFT JOIN app_laws_master m ON m.law_num = a.law_num "
            f"WHERE {pk_where}",
            tuple(pk),
        )
        row = cur.fetchone()
        out[pk] = (row[0], row[1]) if row else (None, None)
    return out


def _retrieve(cur, q_text: str, q_vec_lit: str, *, fetch_k: int, top_m: int) -> list[tuple[tuple, float]]:
    """1 クエリの retrieve：vector + bigm → RRF → top_m の [(pk, score)]。"""
    vhits = _vector_search(cur, q_vec_lit, fetch_k)
    bhits = _bigm_search(cur, q_text, fetch_k, BIGM_SIMILARITY_LIMIT)
    return reciprocal_rank_fusion([vhits, bhits], k=RRF_K, top_m=top_m)


def run_self_retrieval(conn, tei_url: str, samples: int, k: int) -> int:
    """サンプル条文の content をクエリにして自身が返るか（Hit@1/Hit@10/MRR）。"""
    pk_select = ", ".join(PK_COLS)
    order_by = "md5(" + " || ".join(f"{c}::text" for c in PK_COLS) + ")"
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {pk_select}, {TEXT_COL} FROM {TABLE} "
            f"WHERE {EMB_COL} IS NOT NULL AND {TEXT_COL} IS NOT NULL AND {TEXT_COL} <> '' "
            f"ORDER BY {order_by} LIMIT %s",
            (samples,),
        )
        rows = cur.fetchall()

    ranked_lists: list[list[tuple]] = []
    targets: list[tuple] = []
    hit1 = hitk = 0
    with conn.cursor() as cur:
        for i, row in enumerate(rows):
            target = pk_key(row)
            q_text = row[-1]
            q_vec = ef.embed_texts([q_text], tei_url)[0]
            fused = _retrieve(cur, q_text, _vec_literal(q_vec), fetch_k=FETCH_K, top_m=max(k, TOP_M))
            ranked = [pk for pk, _ in fused]
            ranked_lists.append(ranked)
            targets.append(target)
            hit1 += hit_at_k(ranked, target, 1)
            hitk += hit_at_k(ranked, target, k)
            if (i + 1) % 10 == 0:
                print(f"INFO: self-retrieval {i+1}/{len(rows)} …", file=sys.stderr)

    n = len(rows) or 1
    print("\n=== self-retrieval（content→同一条文・パイプライン健全性）===")
    print(f"  サンプル        : {len(rows)} 条文（md5 順・全法令横断）")
    print(f"  Hit@1           : {hit1}/{len(rows)} = {hit1/n*100:.1f}%")
    print(f"  Hit@{k:<11}: {hitk}/{len(rows)} = {hitk/n*100:.1f}%")
    print(f"  MRR             : {mrr(ranked_lists, targets):.3f}")
    print("  ※ vector+bigm+RRF が条文 PK を正しく返せるかの客観確認（ドメイン正答率ではない）。")
    return 0


# 代表クエリ（目視疎通用・関連度ラベルは付けない＝無知の知）。
# 「法令検索で来そうな自然文」を数件。正解条文の宣言はしない（恣意回避）。
DEMO_QUERIES = [
    "個人情報の適正な取得と利用目的の通知について",
    "労働者の時間外労働の上限と割増賃金",
    "建築物の耐震基準と確認申請の手続",
    "食品の表示義務とアレルゲン情報",
    "未成年者の契約の取消しと法定代理人の同意",
]


def run_demo(conn, tei_url: str, queries: Sequence[str], top_n: int = 5) -> int:
    """代表クエリの top-n を表示（目視疎通）。RRF 融合が条文を返すことの確認に留める。"""
    print("\n=== 代表クエリ（目視疎通・関連度ラベルなし）===")
    with conn.cursor() as cur:
        for q in queries:
            q_vec = ef.embed_texts([q], tei_url)[0]
            fused = _retrieve(cur, q, _vec_literal(q_vec), fetch_k=FETCH_K, top_m=top_n)
            disp = _fetch_rows_for_display(cur, [pk for pk, _ in fused])
            print(f"\nQ: {q}")
            if not fused:
                print("  （ヒットなし）")
                continue
            for rank, (pk, score) in enumerate(fused, 1):
                title, content = disp.get(pk, (None, None))
                law_num, anchor = pk
                print(f"  {rank}. [{law_num} {anchor}] {snippet(title or '?', 24)} | {snippet(content or '', 50)} (rrf={score:.4f})")
    print("\n  ※ 上位条文が妥当かは要目視（必要なら rerank seam 併用で精度確認）。")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Law RAG retrieve live smoke (pgvector + pg_bigm + RRF).")
    parser.add_argument("--dsn", default=None, help="PostgreSQL DSN (default: libpq env vars)")
    parser.add_argument("--tei-url", default="http://tei:80", help="TEI base URL (native /embed)")
    parser.add_argument("--samples", type=int, default=30, help="self-retrieval sample count (default 30)")
    parser.add_argument("--k", type=int, default=10, help="top-k for Hit@k (default 10)")
    parser.add_argument("--self-only", action="store_true", help="run self-retrieval only")
    parser.add_argument("--demo-only", action="store_true", help="run demo queries only")
    args = parser.parse_args(argv)

    import psycopg

    rc = 0
    with psycopg.connect(args.dsn or "", autocommit=False) as conn:
        if not args.demo_only:
            rc |= run_self_retrieval(conn, args.tei_url, args.samples, args.k)
        if not args.self_only:
            rc |= run_demo(conn, args.tei_url, DEMO_QUERIES)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())

"""法令 RAG retrieve のラベル付き精度評価（RRF 単体 vs +reranker）— 法令 RAG 所見 A 対処。

背景（所見 A）:
  retrieve_smoke の代表クエリで、自然文（NL）クエリでは pg_bigm が similarity_limit=0.2 でほぼヒットせず
  （全行最大 bigm_similarity ≈0.107）、ハイブリッド検索が vector 単独に縮退することが判明した。
  これを cross-encoder reranker（ruri-v3-reranker・TEI native /rerank）で持ち上げられるかを、
  ラベル付きクエリで Hit@1 / Hit@10 / MRR を **RRF 単体 vs +rerank** で比較して検証する。

評価ラベル（既存資産・恣意なし）:
  deploy `scripts/law-queries.json`＝過去の法令 RAG リランカ検証（Hit@1 45%→90%、汎用 rag_chunks/curated
  29 法令）で使ったラベル `{q(クエリ), needle(正解条文に含まれる部分文字列), law(期待法令名)}` 20 件。
  本ツールはこれを **full app_laws_for_indexing（255,680 行）** に対して回す。`needle` が条文 content に
  含まれれば relevant とみなす（客観判定＝ラベルを CC が作らない＝無知の知）。中小実務法令は full set の部分集合。

retrieve（src/lib/rag と同式）:
  vector(content_embedding <=> q) + bigm(content =% q) → RRF(k=60) で候補プール poolM 件 → 各候補の
  content を取得 → judge(needle ∈ content)。rerank 有効時は (query, [content...]) を TEI /rerank に渡し、
  返った index で候補を並べ替えてから Hit/MRR を測る（RagService.applyRerank と同じ over-fetch→reorder）。

由来（attribution）:
  法令 RAG は Digital Agency of Japan の lawsy-custom-bq（MIT License）を pgvector へ移植したもの。
  reranker 段は本プロジェクトの一般 RAG（src/lib/rag）の rerank seam を法令 retrieve に適用する検証。

使い方（libpq env + TEI_URL + RERANK_URL）:
  python3 law_rag_eval.py --eval-file /scripts/law-queries.json            # RRF vs +rerank 比較
  python3 law_rag_eval.py --eval-file law-queries.json --no-rerank         # RRF 単体だけ
  python3 law_rag_eval.py --eval-file law-queries.json --candidates 20 --k 10

注意:
  psycopg（v3）が必要。retrieve_smoke / embed_fill の純関数・TEI 呼び出しを再利用する。
  rerank の payload/parse・並べ替え・needle 判定・指標計算は純関数に分離しユニットテストする。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Sequence

TOOL_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL_ROOT))
import embed_fill as ef  # noqa: E402
import retrieve_smoke as rs  # noqa: E402

TABLE = rs.TABLE
TEXT_COL = rs.TEXT_COL
PK_COLS = rs.PK_COLS

# rerank 候補プール件数（src/lib/rag RERANK_CANDIDATES 既定 20 と一致）。
RERANK_CANDIDATES = 20


# ---- 純関数（psycopg / ネットワーク不要・ユニットテスト対象） ----------------------------


def build_rerank_payload(query: str, texts: Sequence[str]) -> bytes:
    """TEI native /rerank のリクエストボディ JSON bytes（teiRerankAdapter と同契約）。"""
    return json.dumps({"query": query, "texts": list(texts)}).encode("utf-8")


def parse_rerank_response(raw: bytes) -> list[tuple[int, float]]:
    """TEI /rerank レスポンス [{index, score}] を (index, score) のリストへ（score 降順は TEI 側保証）。"""
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError(f"unexpected TEI /rerank response shape: {type(data).__name__}")
    out: list[tuple[int, float]] = []
    for item in data:
        out.append((int(item["index"]), float(item["score"])))
    return out


def reorder_by_rerank(candidates: Sequence[Any], ranked: Sequence[tuple[int, float]]) -> list[Any]:
    """rerank の (index, score) 降順で candidates を並べ替える。範囲外 index は破棄（teiRerankAdapter と同防御）。

    ranked に現れない候補は末尾へ元順で残す（rerank が一部しか返さない異常時の取りこぼし防止）。
    """
    n = len(candidates)
    seen: set[int] = set()
    out: list[Any] = []
    for idx, _score in ranked:
        if isinstance(idx, int) and 0 <= idx < n and idx not in seen:
            out.append(candidates[idx])
            seen.add(idx)
    for i in range(n):
        if i not in seen:
            out.append(candidates[i])
    return out


def needle_hit(content: str | None, needle: str) -> bool:
    """正解判定：needle（空白差を吸収）が条文 content に含まれるか。"""
    if not content or not needle:
        return False
    norm = lambda s: "".join(s.split())
    return norm(needle) in norm(content)


def metrics_from_relevance(rel_flags: Sequence[bool], k: int) -> tuple[int, int, float]:
    """ランク順の relevant 真偽列から (hit@1, hit@k, reciprocal_rank) を返す。"""
    hit1 = 1 if rel_flags and rel_flags[0] else 0
    hitk = 1 if any(rel_flags[:k]) else 0
    rr = 0.0
    for i, rel in enumerate(rel_flags):
        if rel:
            rr = 1.0 / (i + 1)
            break
    return hit1, hitk, rr


# ---- ネットワーク（TEI /rerank） --------------------------------------------------------


def rerank_texts(query: str, texts: Sequence[str], rerank_url: str, *, timeout: float = 120.0) -> list[tuple[int, float]]:
    """(query, texts) を TEI native /rerank に渡し (index, score) 降順を返す。texts 空は呼ばず空。"""
    if not texts:
        return []
    url = rerank_url.rstrip("/") + "/rerank"
    req = urllib.request.Request(
        url, data=build_rerank_payload(query, texts),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return parse_rerank_response(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"TEI /rerank HTTP {exc.code}: {detail}") from exc


# ---- DB retrieve（候補プール＋content） --------------------------------------------------


def retrieve_pool(cur, q_text: str, q_vec_lit: str, *, fetch_k: int, pool_m: int) -> list[tuple[tuple, str, str | None]]:
    """vector + bigm → RRF で候補プール pool_m 件を [(pk, content, law_title)] で返す（RRF 順）。"""
    vhits = rs._vector_search(cur, q_vec_lit, fetch_k)
    bhits = rs._bigm_search(cur, q_text, fetch_k, rs.BIGM_SIMILARITY_LIMIT)
    fused = rs.reciprocal_rank_fusion([vhits, bhits], k=rs.RRF_K, top_m=pool_m)
    pks = [pk for pk, _ in fused]
    disp = rs._fetch_rows_for_display(cur, pks)  # {pk: (law_title, content)}
    out: list[tuple[tuple, str, str | None]] = []
    for pk in pks:
        title, content = disp.get(pk, (None, None))
        out.append((pk, content or "", title))
    return out


def evaluate(
    *,
    dsn: str | None,
    tei_url: str,
    rerank_url: str | None,
    eval_file: str,
    candidates: int,
    k: int,
) -> int:
    import psycopg

    labels = json.loads(Path(eval_file).read_text(encoding="utf-8"))
    print(f"INFO: ラベル {len(labels)} 件 / candidates={candidates} / k={k} / rerank={'on' if rerank_url else 'off'}",
          file=sys.stderr)

    rrf_h1 = rrf_hk = 0
    rrf_rr = 0.0
    rk_h1 = rk_hk = 0
    rk_rr = 0.0
    rows_out: list[list[Any]] = []

    fetch_k = max(rs.FETCH_K, candidates)
    with psycopg.connect(dsn or "", autocommit=False) as conn:
        with conn.cursor() as cur:
            for i, item in enumerate(labels):
                q, needle, law = item["q"], item["needle"], item.get("law", "")
                q_vec = ef.embed_texts([q], tei_url)[0]
                pool = retrieve_pool(cur, q, rs._vec_literal(q_vec), fetch_k=fetch_k, pool_m=candidates)

                # RRF 順の relevance（needle ∈ content）。
                rrf_rel = [needle_hit(content, needle) for _pk, content, _t in pool]
                h1, hk, rr = metrics_from_relevance(rrf_rel, k)
                rrf_h1 += h1; rrf_hk += hk; rrf_rr += rr

                rk_rank = "-"
                if rerank_url:
                    ranked = rerank_texts(q, [c for _pk, c, _t in pool], rerank_url)
                    reordered = reorder_by_rerank(pool, ranked)
                    rk_rel = [needle_hit(content, needle) for _pk, content, _t in reordered]
                    h1r, hkr, rrr = metrics_from_relevance(rk_rel, k)
                    rk_h1 += h1r; rk_hk += hkr; rk_rr += rrr
                    rk_rank = next((str(j + 1) for j, r in enumerate(rk_rel) if r), "miss")

                rrf_rank = next((str(j + 1) for j, r in enumerate(rrf_rel) if r), "miss")
                rows_out.append([rs.snippet(q, 22), law, rrf_rank, rk_rank])
                print(f"INFO: [{i+1}/{len(labels)}] rrf_rank={rrf_rank} rerank_rank={rk_rank}  {rs.snippet(q,30)}",
                      file=sys.stderr)

    n = len(labels) or 1
    print("\n=== 法令 retrieve 精度（ラベル付き・needle ∈ content 判定）===")
    print("\n[per-query 正解条文の順位]（miss=候補プール外）")
    print(_fmt(["query", "law", "RRF順位", "rerank順位"], rows_out))
    print(f"\n[集計] N={len(labels)}  candidates={candidates}  k={k}")
    print(f"  RRF 単体    : Hit@1 {rrf_h1}/{n}={rrf_h1/n*100:.1f}%  Hit@{k} {rrf_hk}/{n}={rrf_hk/n*100:.1f}%  MRR {rrf_rr/n:.3f}")
    if rerank_url:
        print(f"  +reranker   : Hit@1 {rk_h1}/{n}={rk_h1/n*100:.1f}%  Hit@{k} {rk_hk}/{n}={rk_hk/n*100:.1f}%  MRR {rk_rr/n:.3f}")
        print(f"  Δ Hit@1     : {(rk_h1-rrf_h1)/n*100:+.1f}pt   Δ MRR: {(rk_rr-rrf_rr)/n:+.3f}")
    print("  ※ needle はラベル既定の部分文字列。reranker=ruri-v3-reranker（TEI /rerank・cross-encoder）。")
    return 0


def _fmt(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    """retrieve_smoke.fmt_table は bench 側にあるため簡易整形をローカルに持つ（依存最小）。"""
    cols = [str(h) for h in headers]
    body = [[str(c) for c in r] for r in rows]
    widths = [max(len(cols[i]), *(len(r[i]) for r in body)) if body else len(cols[i]) for i in range(len(cols))]
    line = lambda cells: "  ".join(c.ljust(widths[i]) for i, c in enumerate(cells))
    return "\n".join([line(cols), "  ".join("-" * w for w in widths), *(line(r) for r in body)])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Labeled law RAG retrieve eval: RRF vs +reranker ().")
    parser.add_argument("--dsn", default=None, help="PostgreSQL DSN (default: libpq env vars)")
    parser.add_argument("--tei-url", default="http://tei:80", help="TEI embedding base URL")
    parser.add_argument("--rerank-url", default="http://tei-reranker:80", help="TEI reranker base URL")
    parser.add_argument("--no-rerank", action="store_true", help="RRF 単体のみ（rerank しない）")
    parser.add_argument("--eval-file", required=True, help="labeled queries JSON ({q, needle, law}[])")
    parser.add_argument("--candidates", type=int, default=RERANK_CANDIDATES, help="rerank 候補プール件数（既定 20）")
    parser.add_argument("--k", type=int, default=10, help="Hit@k の k（既定 10）")
    args = parser.parse_args(argv)

    return evaluate(
        dsn=args.dsn,
        tei_url=args.tei_url,
        rerank_url=None if args.no_rerank else args.rerank_url,
        eval_file=args.eval_file,
        candidates=args.candidates,
        k=args.k,
    )


if __name__ == "__main__":
    raise SystemExit(main())

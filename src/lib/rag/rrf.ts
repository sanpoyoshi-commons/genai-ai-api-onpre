/**
 * Reciprocal Rank Fusion（RRF）＝ハイブリッド検索統合（pg_bigm + pgvector）。
 *
 * 複数の順位付きリスト（ベクトル検索・全文検索）を、score 正規化なしに `1 / (k + rank)` の総和で融合する
 * （Cormack et al. 2009、OpenSearch/Elastic 既定）。k は既定 60、rank は 1 起点。同一 id が複数リストに
 * 出れば寄与を加算する。最終的に融合スコア降順で top-M を返す。独自実装 TS
 * （DB 非依存・純関数で unit テスト可能）。チューニング（k・取得件数・top-M）は実機ベンチで確定する。
 */

/** 検索結果の 1 件（順位はリスト内の並び順で決まるため score は融合に使わない）。 */
export interface RankedItem {
  id: string;
}

export interface RrfOptions {
  /** RRF 定数 k（既定 60）。 */
  k: number;
  /** 融合後に返す最大件数（top-M、既定 10）。 */
  topM: number;
}

export const DEFAULT_RRF_OPTIONS: RrfOptions = { k: 60, topM: 10 };

export interface FusedItem {
  id: string;
  /** 融合スコア（各リストの 1/(k+rank) の総和）。 */
  score: number;
}

/**
 * 複数の順位付きリストを RRF で融合する。各リストは順位順（先頭が rank=1）で渡す。
 * 同一 id の寄与は加算。融合スコア降順、同点は最初に出現した順を保つ安定ソートで top-M を返す。
 */
export function reciprocalRankFusion(lists: RankedItem[][], options?: Partial<RrfOptions>): FusedItem[] {
  const { k, topM } = { ...DEFAULT_RRF_OPTIONS, ...options };

  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]?.id;
      if (id === undefined) {
        continue;
      }
      const rank = i + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
      if (!firstSeen.has(id)) {
        firstSeen.set(id, order++);
      }
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0))
    .slice(0, topM);
}

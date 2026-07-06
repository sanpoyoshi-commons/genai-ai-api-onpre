/**
 * Rerank 取得の seam（RAG リランカ）。
 *
 * RagService.retrieve が消費する最小契約を seam として定義し、背後に rerank 抽象化レイヤー
 * （RerankAdapter＝TEI ネイティブ /rerank 経路）を置く。EmbeddingClient seam と同方式（deps 注入・unit は fake
 * 注入・実バックエンド配線はブリッジ RerankAbstractionClient）。RAG の検索結果（候補チャンク）を query との
 * cross-encoder 関連度で並べ替え、Hit@1 を引き上げる。有効化（RERANK_ENABLED）と候補プール数（RERANK_CANDIDATES）
 * は RAG オーケストレーション側（RagConfig）が持つ。本 seam は「並べ替えそのもの」のみを担う。
 */

/** 並べ替え対象の候補（id は呼び出し側の同定用、text を採点に使う）。 */
export interface RerankCandidate {
  id: string;
  text: string;
}

/** rerank 入力。model 未指定時はブリッジが config の既定モデルへ委譲する。 */
export interface RerankInput {
  /** 検索クエリ。 */
  query: string;
  /** 並べ替え対象の候補群。 */
  candidates: RerankCandidate[];
  /** モデル ID（省略時は既定モデル）。 */
  model?: string;
  /** リクエスト識別子（トレース用）。 */
  requestId?: string;
}

/** rerank 結果 1 件（id＋関連度 score）。 */
export interface RerankResultItem {
  id: string;
  score: number;
}

/** rerank 出力。results は関連度降順（id は入力 candidates の id）。 */
export interface RerankOutput {
  results: RerankResultItem[];
  model: string;
}

export interface RerankClient {
  /** 候補を query との関連度で並べ替える（results は降順、id で元候補を引き当てる）。 */
  rerank(input: RerankInput): Promise<RerankOutput>;
}

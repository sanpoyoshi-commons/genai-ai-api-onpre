import type { EmbeddingsOutput } from '../../llm/types.js';

/**
 * Embedding 取得の seam（RAG 用）。
 *
 * 将来の RAG 取込／検索が消費する最小契約を seam として定義し、背後に embedding 抽象化
 * レイヤー（EmbeddingAdapter＝tei/openai/ollama 経路切替）を置く。chat の LlmClient seam と同方式（deps 注入・
 * unit は fake 注入・実バックエンド配線はブリッジ EmbeddingAbstractionClient）。縦スライス
 * （seam＋TEI 実配線＋live e2e）まで。chunking / pgvector 格納 / ハイブリッド検索は後続。
 */

/** 埋め込み入力。model 未指定時はブリッジが config の既定モデル（TEI=ruri-v3-310m）へ委譲する。 */
export interface EmbeddingInput {
  /** モデル ID（省略時は既定モデル）。 */
  model?: string;
  /** 入力テキスト群（複数を一度に投げてベクトルを取得可能）。 */
  input: string[];
  /** リクエスト識別子（トレース用）。 */
  requestId?: string;
}

export interface EmbeddingClient {
  /** 入力テキスト群の埋め込みベクトルを取得する（embeddings[i] が input[i] に対応）。 */
  embed(input: EmbeddingInput): Promise<EmbeddingsOutput>;
}

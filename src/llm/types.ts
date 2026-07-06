import type { LLMError } from './errors.js';

/**
 * LLM 抽象化レイヤーのコア型（text 中心の最小構成）。
 *
 * 抽象化レイヤーの正式型のうち、chat/chatStream（テキスト生成）に必要な部分集合のみを定義する。
 * multimodal（image/document ブロック）・tools・responseFormat・grounding・embeddings は IF を広げず後続に委ねる
 * （ContentBlock は text のみ。multimodal は現状スコープ外）。後続で union を広げる際は破壊的変更に注意。
 */

/** メッセージのロール（現状は system/user/assistant のみ実使用、tool は予約）。 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** コンテンツブロック（現状は text のみ。multimodal は後続で union を拡張）。 */
export type ContentBlock = { type: 'text'; text: string };

/** メッセージ。単純テキストは content:string、将来の multimodal 用に ContentBlock[] も許容。 */
export type Message = {
  role: MessageRole;
  content: string | ContentBlock[];
};

/** 停止理由（OpenAI finish_reason と Bedrock stopReason を吸収する集合）。 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'content_filter'
  | 'error';

/** トークン使用量（ローカル経路は estimatedCostUsd 常に 0）。 */
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 推定コスト（USD）。ローカル経路（ollama/vllm）は常に 0、cloud-api は後続で pricing 算出。 */
  estimatedCostUsd: number;
};

/** chat / chatStream の共通入力。 */
export type ChatInput = {
  /** 解決済みモデル ID。空文字時はアダプタが config の既定モデルへ委譲する。 */
  model: string;
  messages: Message[];
  /** system プロンプト（任意）。messages に system ロールを含めても良い。 */
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** リクエストレベルのタイムアウト（ms）。未指定時は config の既定を使用。 */
  timeoutMs?: number;
  /** リクエスト識別子（ログ／トレース用）。 */
  requestId?: string;
};

/** chat の出力（非ストリーミング）。 */
export type ChatOutput = {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
};

/** chatStream が yield するチャンク（tool 系は後続で追加）。 */
export type ChatChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'message_stop'; stopReason: StopReason }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: LLMError };

/**
 * Embedding 入力（RAG 用。OpenAI Embeddings API 互換）。
 *
 * input は配列に統一して呼び出し側の処理を単純化（OpenAI の string | string[] のうち配列のみ）。
 * dimensions は OpenAI text-embedding-3 系のみ有効（ローカルの TEI/ruri-v3 は次元固定＝768 のため未使用）。
 */
export type EmbeddingsInput = {
  /** 解決済みモデル ID。空文字時はアダプタが config の既定モデルへ委譲する。 */
  model: string;
  /** 入力テキスト群（複数を一度に投げて embedding を取得可能）。 */
  input: string[];
  /** 出力次元数（OpenAI text-embedding-3 系のみ有効。TEI/ruri-v3 等の固定次元モデルでは指定しない）。 */
  dimensions?: number;
  /** リクエスト識別子（ログ／トレース用）。 */
  requestId?: string;
};

/** Embedding 出力。embeddings[i] が input[i] に対応する。 */
export type EmbeddingsOutput = {
  /** 各入力に対応する embedding ベクトル（input と同順）。 */
  embeddings: number[][];
  /** 実際に使用されたモデル ID。 */
  model: string;
  /** トークン使用量（embedding は completionTokens を持たない）。 */
  usage: Pick<Usage, 'promptTokens' | 'totalTokens' | 'estimatedCostUsd'>;
};

/**
 * Rerank 入力（RAG リランカ）。
 *
 * cross-encoder（ruri-v3-reranker-310m）で query と候補テキストの関連度を採点し並べ替える。embeddings と異なり
 * query を全候補と対で評価するため backend（TEI ネイティブ /rerank）は OpenAI 互換でも Jina/Cohere 形式でもない
 * 独自経路。chat/embeddings の Adapter とは別 IF として独立させる（バックエンドが別サービスのため）。
 */
export type RerankRequest = {
  /** 解決済みモデル ID。空文字時はアダプタが config の既定モデルへ委譲する（TEI は単一モデルなので任意）。 */
  model: string;
  /** 検索クエリ。 */
  query: string;
  /** 並べ替え対象の候補（id は呼び出し側の同定用・TEI へは text のみ送る）。 */
  candidates: { id: string; text: string }[];
  /** リクエスト識別子（ログ／トレース用）。 */
  requestId?: string;
};

/** Rerank 出力。results は関連度降順。id は入力 candidates の id を引き当てて返す。 */
export type RerankResponse = {
  /** 関連度降順に並べた候補（id＋score）。 */
  results: { id: string; score: number }[];
  /** 実際に使用されたモデル ID。 */
  model: string;
};

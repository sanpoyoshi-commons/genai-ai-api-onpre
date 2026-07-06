import type { UnrecordedMessage } from '../../types/genaiWeb.js';

/**
 * LLM 推論の seam（seam 注入＋実バックエンド配線は後続）。
 *
 * 上流は `api[model.type].invoke/invokeStream(model, messages, id)`（Bedrock/SageMaker）で推論する。
 * ローカルは LLM 抽象化レイヤー（OpenAI 互換・Ollama/vLLM/cloud-api 経路切替）が
 * 真のバックエンドになる。実装前の段階では、predict/predictTitle/predictStream が消費する
 * 最小契約（テキスト生成＝文字列／逐次文字列）だけを seam として定義し deps 注入する（idp/apiKey と同方式）。
 * 抽象化レイヤーの chat/chatStream（ChatInput→ChatOutput/ChatChunk）はこの seam の背後で実装される。
 * unit テストは fake を注入する。実 LlmClient（抽象化レイヤーへの委譲）は後続で差し替える。
 */

/** 推論入力（上流 invoke の (model, messages, id) に対応）。model は解決済みモデル ID。 */
export interface LlmGenerateInput {
  /** 解決済みモデル ID（resolveTextModel の戻り）。 */
  model: string;
  /** 会話メッセージ列（上流 UnrecordedMessage 互換）。 */
  messages: UnrecordedMessage[];
  /** リクエスト識別子（上流 id・トレース用）。 */
  requestId: string;
  /**
   * サンプリング温度（任意）。未指定時は LlmAbstractionClient の既定（env LLM_DEFAULT_TEMPERATURE）へ委譲。
   * ダイアグラム生成等の構造化出力（mermaid）は低温（〜0.2）の方が書式遵守が安定する。
   */
  temperature?: number;
}

export interface LlmClient {
  /** 非ストリーミング推論。完成テキストを返す（上流 invoke 相当）。 */
  generate(input: LlmGenerateInput): Promise<string>;
  /** ストリーミング推論。テキストデルタを逐次 yield する（上流 invokeStream 相当・呼び出し側が JSONL 整形）。 */
  generateStream(input: LlmGenerateInput): AsyncIterable<string>;
}

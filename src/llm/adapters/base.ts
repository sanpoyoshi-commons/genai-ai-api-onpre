import type { ChatChunk, ChatInput, ChatOutput } from '../types.js';

/**
 * 経路アダプタの抽象 IF。
 *
 * factory が LLM_BACKEND に応じた実装を返す。現状は chat/chatStream（テキスト生成）のみ。embeddings は
 * RAG 側で追加するため IF に含めない（含めると全アダプタに未実装スタブが必要になり最小構成に反する）。
 */
export interface LLMAdapter {
  readonly backend: string;
  /**
   * 画像の ContentBlock を渡してよいか。**未指定は「渡してはいけない」**（既定は安全側）。
   * 表明していない経路へ画像を渡すと黙って落ちるため、添付の層が `status="unsupported"` の注記へ振り替える。
   */
  readonly supportsImages?: boolean;
  chat(input: ChatInput): Promise<ChatOutput>;
  chatStream(input: ChatInput): AsyncIterable<ChatChunk>;
}

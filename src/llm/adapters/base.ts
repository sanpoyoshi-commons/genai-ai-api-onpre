import type { ChatChunk, ChatInput, ChatOutput } from '../types.js';

/**
 * 経路アダプタの抽象 IF。
 *
 * factory が LLM_BACKEND に応じた実装を返す。現状は chat/chatStream（テキスト生成）のみ。embeddings は
 * RAG 側で追加するため IF に含めない（含めると全アダプタに未実装スタブが必要になり最小構成に反する）。
 */
export interface LLMAdapter {
  readonly backend: string;
  chat(input: ChatInput): Promise<ChatOutput>;
  chatStream(input: ChatInput): AsyncIterable<ChatChunk>;
}

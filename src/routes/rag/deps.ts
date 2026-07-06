import type { LlmClient } from '../../lib/llm/llmClient.js';
import type { RagService } from '../../lib/rag/ragService.js';

/** rag Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface RagDeps {
  /** RAG 本体（ingest／retrieve）。EmbeddingClient＋RagRepository＋RagConfig を内包。 */
  rag: RagService;
  /** 回答生成 seam（retrieve-and-generate の generate 側）。LLM 抽象化レイヤー実配線。 */
  llm: LlmClient;
}

import type { LlmClient } from '../../lib/llm/llmClient.js';
import type { KnowledgeLimits } from '../../lib/knowledge/config.js';
import type { RagService } from '../../lib/rag/ragService.js';
import type { StorageBuckets } from '../../lib/storage/config.js';
import type { FileStorage } from '../../lib/storage/fileStorage.js';
import type { KnowledgeRepositoryLike } from '../../repositories/ragRepository.js';

/** rag Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface RagDeps {
  /** RAG 本体（ingest／search）。EmbeddingClient＋RagRepository＋RagConfig を内包。 */
  rag: RagService;
  /** 回答生成 seam（retrieve-and-generate の generate 側）。LLM 抽象化レイヤー実配線。 */
  llm: LlmClient;
  /** ナレッジ集と文書の出し入れ（所有の確認を含む）。 */
  knowledge: KnowledgeRepositoryLike;
  /** 原本（Bronze）の置き場。署名付き URL の発行と、投入時の読み出し・削除に使う。 */
  storage: FileStorage;
  /** バケット名（ナレッジ集は knowledgeBucket。未設定なら投入の経路が 500 を返す）。 */
  buckets: StorageBuckets;
  /** 投入の上限（KNOWLEDGE_*）。 */
  limits: KnowledgeLimits;
}

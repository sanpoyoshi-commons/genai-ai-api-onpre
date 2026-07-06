import type { LlmClient } from '../../lib/llm/llmClient.js';
import type { ChatRepository } from '../../repositories/chatRepository.js';

/** predict Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface PredictDeps {
  /** LLM 推論 seam（generate／generateStream）。実バックエンドは後続配線。 */
  llm: LlmClient;
  /** predictTitle が本人スコープ確認（findById）と書き戻し（setTitle）に使う chat リポジトリ。 */
  chats: Pick<ChatRepository, 'findById' | 'setTitle'>;
}

import type { EmbeddingAdapter } from '../../llm/adapters/embeddingBase.js';
import { createEmbeddingAdapter } from '../../llm/embeddingFactory.js';
import type { EmbeddingsOutput } from '../../llm/types.js';
import type { EmbeddingClient, EmbeddingInput } from './embeddingClient.js';

/**
 * EmbeddingClient seam の実装＝embedding 抽象化レイヤーへの委譲ブリッジ（RAG 用）。
 *
 * seam（embed）を維持し背後に EmbeddingAdapter（tei/openai/ollama）を置く。model 未指定は空文字へ
 * 写像してアダプタ側の既定モデル委譲に乗せる。アダプタは lazy 生成（未配線でも app 起動可・初回使用時に config
 * 解決＝LlmAbstractionClient と同方式）。adapterFactory は注入可能（unit は fake adapter 注入）。
 */
export class EmbeddingAbstractionClient implements EmbeddingClient {
  private adapter?: EmbeddingAdapter;

  constructor(
    private readonly adapterFactory: () => EmbeddingAdapter = () => createEmbeddingAdapter(),
  ) {}

  private get(): EmbeddingAdapter {
    if (!this.adapter) {
      this.adapter = this.adapterFactory();
    }
    return this.adapter;
  }

  async embed(input: EmbeddingInput): Promise<EmbeddingsOutput> {
    return this.get().embed({
      model: input.model ?? '',
      input: input.input,
      requestId: input.requestId,
    });
  }
}

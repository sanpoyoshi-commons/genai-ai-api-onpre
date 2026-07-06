import type { RerankAdapter } from '../../llm/adapters/rerankBase.js';
import { createRerankAdapter } from '../../llm/rerankFactory.js';
import { getRequestLogger } from '../../middleware/requestContext.js';
import type { RerankClient, RerankInput, RerankOutput } from './rerankClient.js';

/**
 * RerankClient seam の実装＝rerank 抽象化レイヤーへの委譲ブリッジ（RAG リランカ）。
 *
 * EmbeddingAbstractionClient と同方式：seam（rerank）を維持し背後に RerankAdapter（TEI 経路）を置く。model 未指定は
 * 空文字へ写像してアダプタ側の既定モデル委譲に乗せる。アダプタは lazy 生成（未配線でも app 起動可・初回使用時に
 * config 解決）。adapterFactory は注入可能（unit は fake adapter 注入）。ログは命名規約（component=api.rerank.<backend>、
 * event=rerank_call_started|succeeded|failed）で llm 抽象化ブリッジと同流儀。失敗時の RRF フォールバック（WARN
 * rerank_degraded）は呼び出し側 RagService が担う（ここでは throw して上位へ委ねる）。
 */
export class RerankAbstractionClient implements RerankClient {
  private adapter?: RerankAdapter;

  constructor(private readonly adapterFactory: () => RerankAdapter = () => createRerankAdapter()) {}

  private get(): RerankAdapter {
    if (!this.adapter) {
      this.adapter = this.adapterFactory();
    }
    return this.adapter;
  }

  async rerank(input: RerankInput): Promise<RerankOutput> {
    const adapter = this.get();
    const log = getRequestLogger().child({ component: `api.rerank.${adapter.backend}` });
    const startedAt = Date.now();
    log.debug(
      { event: 'rerank_call_started', candidates: input.candidates.length },
      'rerank call started',
    );
    try {
      const out = await adapter.rerank({
        model: input.model ?? '',
        query: input.query,
        candidates: input.candidates,
        requestId: input.requestId,
      });
      log.info(
        {
          event: 'rerank_call_succeeded',
          candidates: input.candidates.length,
          latency_ms: Date.now() - startedAt,
        },
        'rerank call succeeded',
      );
      return out;
    } catch (err) {
      log.error(
        {
          event: 'rerank_call_failed',
          candidates: input.candidates.length,
          latency_ms: Date.now() - startedAt,
          error: { message: err instanceof Error ? err.message : String(err) },
        },
        'rerank call failed',
      );
      throw err;
    }
  }
}

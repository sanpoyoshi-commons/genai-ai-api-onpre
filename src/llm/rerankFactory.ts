import { LLMError } from './errors.js';
import type { RerankAdapter } from './adapters/rerankBase.js';
import { createTeiRerankAdapter } from './adapters/teiRerankAdapter.js';
import { type RerankConfig, loadRerankConfig } from './rerankConfig.js';

/**
 * RERANK_BACKEND に応じた rerank アダプタを返す（RAG リランカ）。
 *
 * embedding factory と異なり 1 アダプタでは吸収できない（cloud は OpenAI 互換でなく TEI も独自形式のため）。
 * よって backend ごとに adapter を選ぶ switch を置く。現状は TEI のみ実装、cloud（Cohere/Jina）は default で
 * 未対応エラー（loadRerankConfig が先に弾くが、将来 cloud config を足したときの取りこぼし防止に belt-and-suspenders）。
 */
export function createRerankAdapter(config: RerankConfig = loadRerankConfig()): RerankAdapter {
  switch (config.backend) {
    case 'tei':
      return createTeiRerankAdapter(config);
    default:
      throw new LLMError({
        code: 'NOT_IMPLEMENTED',
        backend: config.backend,
        message: `RERANK_BACKEND='${config.backend}' は未対応です（現状 TEI ネイティブ /rerank のみ）`,
      });
  }
}

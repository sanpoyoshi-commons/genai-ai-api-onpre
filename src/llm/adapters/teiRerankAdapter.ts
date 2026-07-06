import { LLMError } from '../errors.js';
import type { RerankRequest, RerankResponse } from '../types.js';
import { mapStatus } from './openaiErrors.js';
import type { RerankAdapter } from './rerankBase.js';

/**
 * TEI ネイティブ /rerank アダプタ（RAG リランカ）。
 *
 * HuggingFace Text Embeddings Inference の cross-encoder rerank エンドポイント。OpenAI 互換でも Jina/Cohere
 * 形式でもない独自契約：POST `{query, texts[]}` → `[{index, score}]`（score 降順、auto_truncate は TEI 側既定 on）。
 * 返った index は送信 texts の添字なので candidates[index].id へ写像して呼び出し側へ返す。openai SDK は使わず
 * raw fetch + AbortController でタイムアウトを掛け、経路固有例外は LLMError に正規化する（embedding と同流儀）。
 * fetch は注入可能（unit はモック注入）。リトライ無効（抽象化レイヤーはリトライしない・C-17-6）。
 */
export interface TeiRerankConfig {
  backend: string;
  /** TEI rerank サービスのベース URL（/rerank は付けない。例 http://tei-reranker:80）。 */
  baseURL: string;
  /** 認証トークン（認証なし経路は未設定）。設定時のみ Authorization: Bearer を付与する。 */
  apiKey?: string;
  /** 既定モデル ID（TEI は単一モデル起動のためログ整合用）。 */
  defaultModel?: string;
  /** 既定タイムアウト（ms）。 */
  timeoutMs: number;
  /** 注入用 fetch（unit はモック注入）。未指定はグローバル fetch。 */
  fetch?: typeof fetch;
}

/** TEI /rerank のレスポンス 1 件（index は送信 texts の添字）。 */
interface TeiRerankItem {
  index: number;
  score: number;
}

export function createTeiRerankAdapter(config: TeiRerankConfig): RerankAdapter {
  const { backend } = config;
  const doFetch = config.fetch ?? fetch;
  const url = `${config.baseURL.replace(/\/+$/, '')}/rerank`;

  return {
    backend,
    async rerank(req: RerankRequest): Promise<RerankResponse> {
      const model = req.model || config.defaultModel || '';
      // 候補なしは TEI を呼ばず空結果（RagService が ids 0 件を先に弾くが、防御的に短絡する）。
      if (req.candidates.length === 0) {
        return { results: [], model };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            query: req.query,
            texts: req.candidates.map((c) => c.text),
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 200);
          const { code, retryable } = mapStatus(res.status);
          throw new LLMError({
            code,
            backend,
            message: `TEI /rerank ${res.status}: ${detail}`,
            retryable,
            requestId: req.requestId,
          });
        }
        const ranked = (await res.json()) as TeiRerankItem[];
        // 返り index で candidates の id を引き当てる。範囲外 index は破棄（防御）。
        const results = ranked
          .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < req.candidates.length)
          .map((r) => ({ id: req.candidates[r.index]!.id, score: r.score }));
        return { results, model };
      } catch (err) {
        throw toRerankError(err, backend, req.requestId);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** TEI /rerank（fetch 経路）固有例外 → LLMError 正規化。openai SDK 経路の toLLMError とは別流儀（fetch 用）。 */
function toRerankError(err: unknown, backend: string, requestId?: string): LLMError {
  if (err instanceof LLMError) {
    return err;
  }
  // AbortController による timeout（abort）は AbortError として届く。
  if (err instanceof Error && err.name === 'AbortError') {
    return new LLMError({ code: 'TIMEOUT', backend, message: err.message, retryable: true, cause: err, requestId });
  }
  // fetch の接続失敗は TypeError（'fetch failed' 等）として届く。
  if (err instanceof TypeError) {
    return new LLMError({ code: 'NETWORK', backend, message: err.message, retryable: true, cause: err, requestId });
  }
  return new LLMError({
    code: 'INTERNAL',
    backend,
    message: err instanceof Error ? err.message : String(err),
    cause: err,
    requestId,
  });
}

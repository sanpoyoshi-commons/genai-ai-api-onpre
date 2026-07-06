import OpenAI from 'openai';
import { LLMError } from '../errors.js';
import type { EmbeddingsInput, EmbeddingsOutput } from '../types.js';
import type { EmbeddingAdapter } from './embeddingBase.js';
import { toLLMError } from './openaiErrors.js';

/**
 * OpenAI 互換 embedding アダプタ（RAG 用）。
 *
 * openai 公式 SDK を baseURL 差し替えで共通利用する（tei/openai/ollama の 3 経路を 1 アダプタで吸収）。TEI は
 * OpenAI 互換 /v1/embeddings を公開するためローカル既定もこの 1 アダプタで賄える。fetch は注入可能（unit は
 * モック注入）。リトライ無効（maxRetries: 0、chat と同方針）。経路固有例外は共有 toLLMError で LLMError
 * に正規化する。
 */
export interface OpenAICompatEmbeddingConfig {
  backend: string;
  baseURL: string;
  apiKey: string;
  defaultModel?: string;
  timeoutMs: number;
  /**
   * 1 リクエストで送る入力テキストの最大件数。これを超える input はこのサイズで分割して複数リクエストに分け、
   * 結果を順序保持で連結する（tei の `--max-client-batch-size` 超過＝422 を回避）。未指定（or ≤0）は分割なし。
   */
  maxClientBatchSize?: number;
  /** 注入用 fetch（unit はモック注入）。未指定はグローバル fetch。 */
  fetch?: typeof fetch;
}

export function createOpenAICompatEmbeddingAdapter(
  config: OpenAICompatEmbeddingConfig,
): EmbeddingAdapter {
  const { backend } = config;
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0,
    fetch: config.fetch,
  });

  return {
    backend,
    async embed(input: EmbeddingsInput): Promise<EmbeddingsOutput> {
      if (input.input.length === 0) {
        throw new LLMError({
          code: 'INVALID_REQUEST',
          backend,
          message: '埋め込み入力テキストが空です（input に 1 件以上の文字列が必要です）',
          requestId: input.requestId,
        });
      }
      const model = resolveModel(input, config); // 空配列チェックの後・API 呼出前（モデル未指定は即 INVALID_REQUEST）
      const batches = chunk(input.input, config.maxClientBatchSize);
      try {
        const embeddings: number[][] = [];
        let promptTokens = 0;
        let totalTokens = 0;
        let usedModel = model;
        for (const batch of batches) {
          const res = await client.embeddings.create({
            model,
            input: batch,
            // encoding_format を 'float' で明示する。openai SDK は未指定だと base64 を要求し内部デコードするが、
            // TEI の OpenAI 互換レイヤーは base64 を返さない可能性があり噛み合わない。float 固定で経路差を消す。
            encoding_format: 'float',
            // dimensions は OpenAI text-embedding-3 系のみ有効。未指定時は省略（TEI/ruri-v3 等の固定次元は送らない）。
            ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
          });
          const mapped = mapEmbeddings(res);
          embeddings.push(...mapped.embeddings); // batches は入力順・各 batch も index 昇順＝全体で input と対応
          promptTokens += mapped.usage.promptTokens;
          totalTokens += mapped.usage.totalTokens;
          usedModel = mapped.model;
        }
        return {
          embeddings,
          model: usedModel,
          usage: { promptTokens, totalTokens, estimatedCostUsd: 0 },
        };
      } catch (err) {
        throw toLLMError(err, backend, input.requestId);
      }
    },
  };
}

/** input をバッチ最大件数で分割する（size 未指定 or ≤0、もしくは件数が size 以下なら分割せず単一バッチ）。 */
function chunk(items: string[], size: number | undefined): string[][] {
  if (!size || size <= 0 || items.length <= size) {
    return [items];
  }
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** EmbeddingsInput.model が空なら config の既定モデルへ委譲。双方空はモデル未指定エラー。 */
function resolveModel(input: EmbeddingsInput, config: OpenAICompatEmbeddingConfig): string {
  const model = input.model || config.defaultModel;
  if (!model) {
    throw new LLMError({
      code: 'INVALID_REQUEST',
      backend: config.backend,
      message:
        '埋め込みモデルが指定されていません（EMBEDDING_MODEL_ID 等の既定モデルを設定してください）',
      requestId: input.requestId,
    });
  }
  return model;
}

/** OpenAI Embeddings レスポンス → EmbeddingsOutput。data は index 昇順に並べ直して input と対応させる。 */
function mapEmbeddings(res: OpenAI.CreateEmbeddingResponse): EmbeddingsOutput {
  const embeddings = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return {
    embeddings,
    model: res.model,
    usage: {
      promptTokens: res.usage?.prompt_tokens ?? 0,
      totalTokens: res.usage?.total_tokens ?? 0,
      estimatedCostUsd: 0, // ローカル経路（tei/ollama）は常に 0。cloud pricing は後続。
    },
  };
}

import { LLMError } from './errors.js';

/**
 * Embedding 経路設定の読込（RAG 用）。
 *
 * `EMBEDDING_BACKEND`（既定 tei）で経路を選ぶ。対応経路はいずれも OpenAI Embeddings API 互換
 * （`/v1/embeddings`）で吸収できる tei（ローカル既定・ruri-v3-310m）/ openai / ollama。chat 側の
 * loadLlmConfig（LLM_BACKEND）とは独立（embedding バックエンドは chat と別サービスのため）。
 * `.env` を簡潔に保つため、ローカル経路（tei/ollama）は非秘密を既定値・秘密は不要、cloud（openai）のみ
 * API キー必須。lazy 読込（factory が使用時に呼ぶ）＝未配線でも app 起動可・使用時に例外。
 */
export interface EmbeddingConfig {
  /** 経路。'tei'（既定・ローカル）| 'openai' | 'ollama'（いずれも OpenAI 互換 /v1/embeddings）。 */
  backend: string;
  /** OpenAI 互換エンドポイント（/v1 まで含む）。SDK が /embeddings を付与する。 */
  baseURL: string;
  /** API キー。認証なし経路（tei/ollama）はダミー。 */
  apiKey: string;
  /** 既定埋め込みモデル。EmbeddingsInput.model が空のとき使用。 */
  defaultModel?: string;
  /** 既定タイムアウト（ms）。 */
  timeoutMs: number;
  /**
   * 1 リクエストで送る入力テキストの最大件数（client-side バッチ分割の閾値）。これを超える input は
   * このサイズで分割し複数リクエストへ分け、結果を順序保持で連結する。tei は warmup OOM 対策で
   * `--max-client-batch-size 8`（deploy compose 既定）に絞っており、超過送信は 422 になるため分割が要る。
   * deploy の `EMBEDDING_MAX_CLIENT_BATCH_SIZE` と同名 env で上書き可（既定: tei/ollama=8・openai=2048）。
   */
  maxClientBatchSize: number;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 分（chat 側と同値）

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string, backend: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new LLMError({
      code: 'AUTHENTICATION',
      backend,
      message: `${backend} 埋め込み経路には環境変数 ${key} が必要です`,
    });
  }
  return value;
}

export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const backend = (env.EMBEDDING_BACKEND ?? 'tei').trim().toLowerCase();
  const timeoutMs =
    parsePositiveInt(env.EMBEDDING_DEFAULT_TIMEOUT_MS) ??
    parsePositiveInt(env.LLM_DEFAULT_TIMEOUT_MS) ??
    DEFAULT_TIMEOUT_MS;
  // バッチ分割の閾値。env 上書き優先、なければ経路既定（tei/ollama は保守的に 8、openai は緩い 2048）。
  const maxClientBatchSize =
    parsePositiveInt(env.EMBEDDING_MAX_CLIENT_BATCH_SIZE) ?? (backend === 'openai' ? 2048 : 8);

  switch (backend) {
    case 'tei':
      // HuggingFace Text Embeddings Inference（ローカル既定）。OpenAI 互換 /v1/embeddings を公開する。
      // ruri-v3-310m（768 次元・Apache-2.0）を serving。deploy の tei サービス（--port 80）が既定の解決先。
      // 既定モデルは deploy の EMBEDDING_MODEL_ID と突合（TEI は --model-id 起動なので model 名は任意でも
      // 同一モデルが返るが、ログ整合のため既定を ruri-v3-310m に合わせる）。
      return {
        backend,
        baseURL: env.EMBEDDING_BASE_URL?.trim() || 'http://tei:80/v1',
        apiKey: 'tei', // 認証なし。SDK が非空 apiKey を要求するためのダミー。
        defaultModel: env.EMBEDDING_MODEL_ID?.trim() || 'cl-nagoya/ruri-v3-310m',
        timeoutMs,
        maxClientBatchSize,
      };
    case 'ollama':
      return {
        backend,
        baseURL: env.EMBEDDING_BASE_URL?.trim() || env.OLLAMA_BASE_URL?.trim() || 'http://ollama:11434/v1',
        apiKey: 'ollama',
        defaultModel: env.OLLAMA_DEFAULT_EMBED_MODEL?.trim() || undefined,
        timeoutMs,
        maxClientBatchSize,
      };
    case 'openai':
      return {
        backend,
        baseURL: env.EMBEDDING_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
        apiKey: requireEnv(env, 'OPENAI_API_KEY', backend),
        defaultModel: env.OPENAI_DEFAULT_EMBED_MODEL?.trim() || 'text-embedding-3-small',
        timeoutMs,
        maxClientBatchSize,
      };
    default:
      throw new LLMError({
        code: 'NOT_IMPLEMENTED',
        backend,
        message: `EMBEDDING_BACKEND='${backend}' は未対応です（対応経路は OpenAI 互換の tei/openai/ollama）`,
      });
  }
}

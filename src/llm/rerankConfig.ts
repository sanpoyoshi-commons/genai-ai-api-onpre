import { LLMError } from './errors.js';

/**
 * Rerank 経路設定の読込（RAG リランカ）。
 *
 * `RERANK_BACKEND`（既定 tei）で経路を選ぶ。現状は TEI ネイティブ /rerank（ローカル既定・ruri-v3-reranker-310m）
 * のみ実装する。cloud（Cohere/Jina）は IF の口だけ用意し default で未対応エラー（実 backend 配線は課金前提の
 * 別タスク）。embedding 側 loadEmbeddingConfig と独立（rerank バックエンドは embedding と別サービスのため）。
 * lazy 読込（factory が使用時に呼ぶ）＝未配線でも app 起動可・使用時に例外。RERANK_ENABLED / RERANK_CANDIDATES
 * は RAG オーケストレーション側の知識（有効化・候補プール数）のため RagConfig（loadRagConfig）が読む。本 config は
 * アダプタ経路（どこへ・どのモデルで・タイムアウト）のみを担う。
 */
export interface RerankConfig {
  /** 経路。'tei'（既定・ローカル TEI ネイティブ /rerank）。cloud は後続。 */
  backend: string;
  /** TEI rerank サービスのベース URL（/rerank は付けない）。 */
  baseURL: string;
  /** 認証トークン（認証なし経路は未設定）。 */
  apiKey?: string;
  /** 既定モデル ID（TEI は単一モデル起動のためログ整合用）。 */
  defaultModel?: string;
  /** 既定タイムアウト（ms）。 */
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000; // 1 分（rerank は候補 20 件程度の cross-encoder 採点・chat ほど長くない）。

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function loadRerankConfig(env: NodeJS.ProcessEnv = process.env): RerankConfig {
  const backend = (env.RERANK_BACKEND ?? 'tei').trim().toLowerCase();
  const timeoutMs = parsePositiveInt(env.RERANK_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

  switch (backend) {
    case 'tei':
      // HuggingFace Text Embeddings Inference の cross-encoder rerank（ローカル既定）。deploy の tei-reranker
      // サービス（profile: rerank、ruri-v3-reranker-310m-onnx）が既定の解決先。TEI は --model-id 起動なので
      // model 名は任意でも同一モデルが返るが、ログ整合のため既定を ruri-v3-reranker-310m に合わせる。
      return {
        backend,
        baseURL: env.RERANK_BASE_URL?.trim() || 'http://tei-reranker:80',
        defaultModel: env.RERANK_MODEL_ID?.trim() || 'cl-nagoya/ruri-v3-reranker-310m',
        timeoutMs,
      };
    default:
      throw new LLMError({
        code: 'NOT_IMPLEMENTED',
        backend,
        message: `RERANK_BACKEND='${backend}' は未対応です（現状 TEI ネイティブ /rerank のみ。cloud（Cohere/Jina）は後続）`,
      });
  }
}

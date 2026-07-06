import type { ChunkOptions } from './chunking.js';
import { DEFAULT_CHUNK_OPTIONS, DEFAULT_SEPARATORS } from './chunking.js';
import type { RrfOptions } from './rrf.js';
import { DEFAULT_RRF_OPTIONS } from './rrf.js';

/**
 * RAG チューニング設定（初期値・env 上書き可）。最終値は実機ベンチで確定する
 * （chunk／RRF）。個人開発者は env 1 行で調整できる。
 */
export interface RagConfig {
  /** チャンキング（max_chunk_size / overlap / separators）。 */
  chunk: ChunkOptions;
  /** RRF（k / top-M）。 */
  rrf: RrfOptions;
  /** 各検索ソース（ベクトル・全文）の取得件数（over-fetch then trim・既定 20）。 */
  fetchK: number;
  /** pg_bigm の類似度下限（既定 0.2＝公式既定 0.3 より緩め・recall 重視）。 */
  bigmSimilarityLimit: number;
  /** RAG③ リランカのオーケストレーション設定（有効化・候補プール数）。経路設定は loadRerankConfig が別管理。 */
  rerank: RerankOrchestration;
}

/** リランカのオーケストレーション設定（RagService.retrieve が参照する有効化・候補プール）。 */
export interface RerankOrchestration {
  /** rerank 段を有効化するか（既定 false＝tei-reranker 未起動環境を壊さない）。 */
  enabled: boolean;
  /** rerank 有効時に RRF で広げる候補プール件数（over-fetch、既定 20）。rerank 後に topM へ絞る。 */
  candidates: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** env から RAG 設定を読む（未設定は既定の初期値）。 */
export function loadRagConfig(): RagConfig {
  return {
    chunk: {
      maxChunkSize: intEnv('RAG_MAX_CHUNK_SIZE', DEFAULT_CHUNK_OPTIONS.maxChunkSize),
      chunkOverlap: intEnv('RAG_CHUNK_OVERLAP', DEFAULT_CHUNK_OPTIONS.chunkOverlap),
      separators: DEFAULT_SEPARATORS,
    },
    rrf: {
      k: intEnv('RAG_RRF_K', DEFAULT_RRF_OPTIONS.k),
      topM: intEnv('RAG_TOP_M', DEFAULT_RRF_OPTIONS.topM),
    },
    fetchK: intEnv('RAG_FETCH_K', 20),
    bigmSimilarityLimit: floatEnv('RAG_BIGM_SIMILARITY_LIMIT', 0.2),
    rerank: {
      enabled: boolEnv('RERANK_ENABLED', false),
      candidates: intEnv('RERANK_CANDIDATES', 20),
    },
  };
}

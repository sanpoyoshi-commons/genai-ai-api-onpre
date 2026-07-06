import { ImageError } from './errors.js';

/**
 * 画像生成バックエンド設定（LlmConfig と対称）。
 *
 * `IMAGE_BACKEND`（既定 sdcpp）で経路を選ぶ。現状は stable-diffusion.cpp server のみ実装。
 * 非秘密は既定値・秘密なし（sd-server は認証なし）＝個人開発者の `.env` 最小設定を保つ。lazy 読込（factory が
 * 使用時に呼ぶ＝未配線でも app 起動可・初回生成時に解決＝LLM/Storage と同方式）。
 */
export interface ImageConfig {
  /** 経路。現状は 'sdcpp' のみ。 */
  backend: string;
  /** sd-server のベース URL（/sdcpp/v1 の手前まで）。 */
  baseURL: string;
  /** 生成完了までのポーリング上限（ms）。 */
  timeoutMs: number;
  /** ジョブ状態ポーリング間隔（ms）。 */
  pollIntervalMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 分（CPU 推論を見込む。C-IMG-2）
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function loadImageConfig(env: NodeJS.ProcessEnv = process.env): ImageConfig {
  const backend = (env.IMAGE_BACKEND ?? 'sdcpp').trim().toLowerCase();
  const timeoutMs = parsePositiveInt(env.IMAGE_GENERATION_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = parsePositiveInt(env.IMAGE_POLL_INTERVAL_MS) ?? DEFAULT_POLL_INTERVAL_MS;

  switch (backend) {
    case 'sdcpp':
      return {
        backend,
        baseURL: env.SDCPP_BASE_URL?.trim() || 'http://sdcpp:8080',
        timeoutMs,
        pollIntervalMs,
      };
    default:
      throw new ImageError({
        code: 'INTERNAL',
        backend,
        message: `IMAGE_BACKEND='${backend}' は未対応です（現状は stable-diffusion.cpp server＝'sdcpp' のみ）`,
      });
  }
}

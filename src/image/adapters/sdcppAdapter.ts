import { ImageError, type ImageErrorCode } from '../errors.js';
import type { ImageGenRequest, SdcppImgGenRequest, SdcppJobAccepted, SdcppJobStatus } from '../types.js';
import type { ImageAdapter } from './base.js';

/**
 * stable-diffusion.cpp server アダプタ（ネイティブ非同期 API）。
 *
 * `POST /sdcpp/v1/img_gen` でジョブを投入し `GET /sdcpp/v1/jobs/{id}` を completed/failed まで poll、
 * `result.images[0].b64_json` を返す（api.md 準拠）。同期 seam（generateImage: Promise<string>）の内側に
 * ポーリングを閉じ込める。fetch/sleep は注入可能（unit はモック注入＝openaiCompatAdapter と同方式）。
 * 経路固有失敗は toImageError で ImageError に正規化する。
 */
export interface SdcppAdapterConfig {
  baseURL: string;
  timeoutMs: number;
  pollIntervalMs: number;
  /** 注入用 fetch（unit はモック注入）。未指定はグローバル fetch。 */
  fetch?: typeof fetch;
  /** 注入用 sleep（unit は no-op 注入で高速化）。未指定は setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

const BACKEND = 'sdcpp';

export function createSdcppAdapter(config: SdcppAdapterConfig): ImageAdapter {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = config.baseURL.replace(/\/+$/, '');

  async function postJson(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ImageError({ code: 'NETWORK', backend: BACKEND, message: connMessage(err), cause: err });
    }
    if (!res.ok) {
      throw await httpError(res);
    }
    return res.json();
  }

  /** タイムアウト時のジョブ取消（best-effort・失敗は無視＝滞留防止が目的）。 */
  async function cancelJob(id: string): Promise<void> {
    try {
      await doFetch(`${base}/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    } catch {
      // cancel 失敗はタイムアウト本来のエラーを優先するため握り潰す。
    }
  }

  async function getJob(id: string): Promise<SdcppJobStatus> {
    let res: Response;
    try {
      res = await doFetch(`${base}/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { method: 'GET' });
    } catch (err) {
      throw new ImageError({ code: 'NETWORK', backend: BACKEND, message: connMessage(err), cause: err });
    }
    if (!res.ok) {
      throw await httpError(res);
    }
    return (await res.json()) as SdcppJobStatus;
  }

  return {
    backend: BACKEND,
    async generate(request: ImageGenRequest): Promise<string> {
      const accepted = (await postJson('/sdcpp/v1/img_gen', toWire(request))) as SdcppJobAccepted;
      if (!accepted?.id) {
        throw new ImageError({ code: 'INTERNAL', backend: BACKEND, message: 'img_gen 応答に job id がありません' });
      }

      const deadline = Date.now() + config.timeoutMs;
      for (;;) {
        const job = await getJob(accepted.id);
        const status = (job.status ?? '').toLowerCase();
        if (status === 'completed') {
          const b64 = job.result?.images?.[0]?.b64_json;
          if (!b64) {
            throw new ImageError({ code: 'INTERNAL', backend: BACKEND, message: '完了ジョブに画像データがありません' });
          }
          return b64;
        }
        if (status === 'failed' || status === 'cancelled') {
          throw new ImageError({
            code: 'GENERATION_FAILED',
            backend: BACKEND,
            message: job.error ?? `画像生成ジョブが ${status} で終了しました`,
          });
        }
        if (Date.now() >= deadline) {
          // 放置するとサーバ側でジョブが走り続け後続を塞ぐ（live e2e で観測）。best-effort で cancel する。
          await cancelJob(accepted.id);
          throw new ImageError({
            code: 'TIMEOUT',
            backend: BACKEND,
            message: `画像生成が ${config.timeoutMs}ms 以内に完了しませんでした`,
          });
        }
        await sleep(config.pollIntervalMs);
      }
    },
  };
}

/** 正規化リクエスト → sd.cpp ネイティブ img_gen JSON（api.md 準拠）。 */
function toWire(r: ImageGenRequest): SdcppImgGenRequest {
  const body: SdcppImgGenRequest = { prompt: r.prompt };
  if (r.negativePrompt) {
    body.negative_prompt = r.negativePrompt;
  }
  if (r.width !== undefined) {
    body.width = r.width;
  }
  if (r.height !== undefined) {
    body.height = r.height;
  }
  if (r.seed !== undefined) {
    body.seed = r.seed;
  }

  const sample: NonNullable<SdcppImgGenRequest['sample_params']> = {};
  if (r.steps !== undefined) {
    sample.sample_steps = r.steps;
  }
  if (r.cfgScale !== undefined) {
    sample.guidance = { txt_cfg: r.cfgScale };
  }
  if (Object.keys(sample).length > 0) {
    body.sample_params = sample;
  }

  if (r.initImage) {
    body.init_image = r.initImage;
  }
  if (r.strength !== undefined) {
    body.strength = r.strength;
  }
  if (r.maskImage) {
    body.mask_image = r.maskImage;
  }
  if (r.controlImage) {
    body.control_image = r.controlImage;
  }
  if (r.controlStrength !== undefined) {
    body.control_strength = r.controlStrength;
  }
  return body;
}

function connMessage(err: unknown): string {
  return `sd-server へ接続できません: ${err instanceof Error ? err.message : String(err)}`;
}

/** HTTP 非 2xx を ImageError へ。本文は best-effort で読む。 */
async function httpError(res: Response): Promise<ImageError> {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    // 本文取得失敗は無視（status のみで写像）。
  }
  const { code } = mapStatus(res.status);
  return new ImageError({
    code,
    backend: BACKEND,
    message: `sd-server エラー (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
  });
}

function mapStatus(status: number): { code: ImageErrorCode } {
  switch (status) {
    case 400:
      return { code: 'INVALID_REQUEST' };
    case 404:
      // 必要モデル未ロード（inpaint/ControlNet 未配置）や job 不在。明示エラー側へ寄せる。
      return { code: 'MODEL_NOT_LOADED' };
    default:
      return { code: 'INTERNAL' };
  }
}

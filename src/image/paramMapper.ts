import { z } from 'zod';
import { ImageError } from './errors.js';
import type { ImageGenMode, ImageGenRequest, SourceImageParams } from './types.js';

/**
 * GenerateImageParams（標準化パラメータ・MIT アイデア領域）→ バックエンド非依存の ImageGenRequest 写像
 * （アダプタ写像・フロント無改修）。
 *
 * sd.cpp/SD 系に存在しないモードは MODE_NOT_SUPPORTED で弾く（能力内フルパリティ）：
 *  - taskType OUTPAINTING / COLOR_GUIDED_GENERATION / BACKGROUND_REMOVAL（Bedrock Titan/Nova 固有）
 *  - maskPrompt（自然言語マスク＝SAM 等が要る）
 *  - colors（color-guided generation）
 * 残る txt2img / img2img / inpaint / ControlNet を ImageGenRequest へ正規化する。重みは prompt/negativePrompt へ
 * 振り分け、SD 注意記法 `(text:weight)` で表現する。
 */

const BACKEND = 'sdcpp';

const textPromptSchema = z.object({ text: z.string(), weight: z.number() });

const sourceParamsSchema = z.object({
  taskType: z
    .enum(['TEXT_IMAGE', 'IMAGE_VARIATION', 'INPAINTING', 'OUTPAINTING', 'COLOR_GUIDED_GENERATION', 'BACKGROUND_REMOVAL'])
    .optional(),
  textPrompt: z.array(textPromptSchema).min(1, 'textPrompt が空です'),
  cfgScale: z.number().optional(),
  seed: z.number().optional(),
  step: z.number().optional(),
  stylePreset: z.string().optional(),
  imageStrength: z.number().optional(),
  height: z.number().optional(),
  width: z.number().optional(),
  initImage: z.string().optional(),
  maskImage: z.string().optional(),
  maskPrompt: z.string().optional(),
  controlStrength: z.number().optional(),
  controlMode: z.enum(['CANNY_EDGE', 'SEGMENTATION']).optional(),
  colors: z.array(z.string()).optional(),
});

const UNSUPPORTED_TASK_TYPES = new Set(['OUTPAINTING', 'COLOR_GUIDED_GENERATION', 'BACKGROUND_REMOVAL']);

function notSupported(message: string): never {
  throw new ImageError({ code: 'MODE_NOT_SUPPORTED', backend: BACKEND, message });
}

function invalid(message: string): never {
  throw new ImageError({ code: 'INVALID_REQUEST', backend: BACKEND, message });
}

export function mapToImageGenRequest(model: string, params: Record<string, unknown>): ImageGenRequest {
  const parsed = sourceParamsSchema.safeParse(params);
  if (!parsed.success) {
    invalid(parsed.error.issues[0]?.message ?? '画像生成パラメータが不正です');
  }
  const p: SourceImageParams = parsed.data;

  // sd.cpp/SD 系に存在しないモードを明示的に弾く（501 相当）。
  if (p.taskType && UNSUPPORTED_TASK_TYPES.has(p.taskType)) {
    notSupported(`taskType '${p.taskType}' は stable-diffusion.cpp では未対応です`);
  }
  if (p.maskPrompt) {
    notSupported('maskPrompt（自然言語マスク）は stable-diffusion.cpp では未対応です');
  }
  if (p.colors && p.colors.length > 0) {
    notSupported('color-guided generation は stable-diffusion.cpp では未対応です');
  }

  const { prompt, negativePrompt } = buildPrompts(p.textPrompt);

  const request: ImageGenRequest = {
    model,
    mode: 'txt2img',
    prompt,
    negativePrompt,
    width: p.width,
    height: p.height,
    steps: p.step,
    cfgScale: p.cfgScale,
    seed: p.seed,
  };

  // モード判定（優先度：ControlNet > inpaint > img2img > txt2img）。
  if (p.controlMode) {
    if (!p.initImage) {
      invalid('ControlNet（controlMode）には条件画像（initImage）が必要です');
    }
    request.mode = 'controlnet';
    request.controlImage = p.initImage;
    request.controlStrength = p.controlStrength;
  } else if (p.maskImage) {
    if (!p.initImage) {
      invalid('inpaint（maskImage）には元画像（initImage）が必要です');
    }
    request.mode = 'inpaint';
    request.initImage = p.initImage;
    request.maskImage = p.maskImage;
    request.strength = p.imageStrength;
  } else if (p.initImage) {
    request.mode = 'img2img';
    request.initImage = p.initImage;
    request.strength = p.imageStrength;
  }

  return request;
}

/** 重み付きプロンプトを正負へ振り分け、SD 注意記法へ整形する。weight<0 を negative、>=0 を positive とする。 */
function buildPrompts(textPrompt: SourceImageParams['textPrompt']): { prompt: string; negativePrompt?: string } {
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const tp of textPrompt) {
    const text = tp.text.trim();
    if (!text) {
      continue;
    }
    if (tp.weight < 0) {
      negatives.push(formatWeighted(text, Math.abs(tp.weight)));
    } else {
      positives.push(formatWeighted(text, tp.weight));
    }
  }
  if (positives.length === 0) {
    invalid('正のプロンプト（weight>=0 の textPrompt）が必要です');
  }
  const prompt = positives.join(', ');
  const negativePrompt = negatives.length > 0 ? negatives.join(', ') : undefined;
  return { prompt, negativePrompt };
}

/** weight==1（既定）はそのまま、それ以外は SD 注意記法 `(text:weight)`。 */
function formatWeighted(text: string, weight: number): string {
  return weight === 1 ? text : `(${text}:${weight})`;
}

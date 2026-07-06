import type { RequestHandler } from 'express';
import { z } from 'zod';
import { type ImageError, isImageError } from '../../image/errors.js';
import { ApiError } from '../../lib/http/errors.js';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { modelNotAllowedAsBadRequest } from '../../lib/llm/models.js';
import { resolveImageModel } from '../../lib/image/models.js';
import { parseBody } from '../../lib/http/validation.js';
import type { ImageDeps } from './deps.js';

const generateImageSchema = z.object({
  model: z
    .object({
      type: z.enum(['bedrock', 'sagemaker']).optional(),
      modelId: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
  params: z.record(z.string(), z.unknown()),
});

/**
 * generateImage（POST /image/generate、MIT 移植）。画像モデルを解決し ImageClient seam で生成、base64 を返す。
 *
 * 上流は base64 を isBase64Encoded で返す（API GW がバイナリへ復号）。ローカルは API GW を介さないため、
 * base64 文字列を JSON 応答として返す（res.json で文字列リテラル化、フロントは base64 を直接扱う）。
 * モデル不許可は 400。
 */
export function createGenerateImageHandler(deps: ImageDeps): RequestHandler {
  return createApiHandler(async ({ req }) => {
    const { model, params } = parseBody(generateImageSchema, req.body);

    let resolvedModel: string;
    try {
      resolvedModel = resolveImageModel(model);
    } catch (error) {
      modelNotAllowedAsBadRequest(error);
    }

    let base64: string;
    try {
      base64 = await deps.image.generateImage({ model: resolvedModel, params });
    } catch (error) {
      imageErrorAsApiError(error);
    }
    return { status: 200, body: base64 };
  });
}

/**
 * ImageError を HTTP status へ写像する（能力内フルパリティ＝未対応モードは 501 で明示）。
 * MODE_NOT_SUPPORTED / MODEL_NOT_LOADED → 501、INVALID_REQUEST → 400、それ以外（TIMEOUT/NETWORK/
 * GENERATION_FAILED/INTERNAL）→ 502（バックエンド起因）。ImageError 以外はそのまま再送（errorHandler が 500）。
 */
function imageErrorAsApiError(error: unknown): never {
  if (!isImageError(error)) {
    throw error;
  }
  const e = error as ImageError;
  switch (e.code) {
    case 'MODE_NOT_SUPPORTED':
    case 'MODEL_NOT_LOADED':
      throw new ApiError(501, e.message);
    case 'INVALID_REQUEST':
      throw new ApiError(400, e.message);
    default:
      throw new ApiError(502, e.message);
  }
}

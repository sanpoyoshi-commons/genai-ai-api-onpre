import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { modelNotAllowedAsBadRequest, resolveTextModel } from '../../lib/llm/models.js';
import { parseBody } from '../../lib/http/validation.js';
import type { PredictDeps } from './deps.js';
import { predictSchema } from './schemas.js';

/**
 * predict（POST /predict、MIT 移植）。非ストリーミング推論。モデルを解決し LLM seam で生成、本文を返す。
 * 上流は応答文字列を JSON.stringify して返す（HTTP body は JSON 文字列リテラル）。本リポは res.json で
 * 同形（"..."）になる。モデル不許可は 400。
 */
export function createPredictHandler(deps: PredictDeps): RequestHandler {
  return createApiHandler(async ({ req }) => {
    const { model, messages, id, temperature } = parseBody(predictSchema, req.body);

    let resolvedModel: string;
    try {
      resolvedModel = resolveTextModel(model);
    } catch (error) {
      modelNotAllowedAsBadRequest(error);
    }

    const text = await deps.llm.generate({ model: resolvedModel, messages, requestId: id, temperature });
    return { status: 200, body: text };
  });
}

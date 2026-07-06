import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { isModelNotAllowedError, resolveTextModel, MODEL_NOT_ALLOWED_MESSAGE } from '../../lib/llm/models.js';
import { streamingChunkLine } from '../../lib/llm/streaming.js';
import { parseBody } from '../../lib/http/validation.js';
import type { PredictDeps } from './deps.js';
import { predictSchema } from './schemas.js';

/**
 * predictStream（POST /predict/stream、MIT 移植）。ストリーミング推論を JSONL（chunked）で流す。
 *
 * 上流は非ルート（Lambda response streaming）。ローカルは /api（requireAuth 内側）の Express ルートとして
 * 公開し、createApiHandler 経由で auth/log/エラー funnel を共有する。本文を res へ直接 chunked 書き出しするため、
 * 戻り値 {status:200} は headersSent により createApiHandler 側で整形スキップされる。
 * モデル不許可は 400 にせず、上流同様にエラーチャンク（stopReason:'error'）をストリームへ書いて 200 で閉じる。
 * ストリーム開始後の他例外は error チャンクを書いて閉じる（headersSent 後は status を変えられないため）。
 */
export function createPredictStreamHandler(deps: PredictDeps): RequestHandler {
  return createApiHandler(async ({ req, res }) => {
    const { model, messages, id, temperature } = parseBody(predictSchema, req.body);

    // モデル解決はストリーム開始前。不許可は専用エラーチャンクで握る（上流 writeModelNotAllowedStream 相当）。
    let resolvedModel: string;
    try {
      resolvedModel = resolveTextModel(model);
    } catch (error) {
      if (isModelNotAllowedError(error)) {
        res.status(200).type('application/json');
        res.write(streamingChunkLine({ text: MODEL_NOT_ALLOWED_MESSAGE, stopReason: 'error' }));
        res.end();
        return { status: 200 };
      }
      throw error;
    }

    res.status(200).type('application/json');
    try {
      for await (const token of deps.llm.generateStream({
        model: resolvedModel,
        messages,
        requestId: id,
        temperature,
      })) {
        res.write(streamingChunkLine({ text: token }));
      }
    } catch (error) {
      if (!res.headersSent && isModelNotAllowedError(error)) {
        res.write(streamingChunkLine({ text: MODEL_NOT_ALLOWED_MESSAGE, stopReason: 'error' }));
        res.end();
        return { status: 200 };
      }
      // ストリーム開始後の例外：status は変えられないため error チャンクで閉じる。
      res.write(streamingChunkLine({ text: '', stopReason: 'error' }));
      res.end();
      return { status: 200 };
    }

    res.end();
    return { status: 200 };
  });
}

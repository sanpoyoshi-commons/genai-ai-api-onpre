import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { modelNotAllowedAsBadRequest, resolveTextModel } from '../../lib/llm/models.js';
import { buildRagMessages, composeAnswer } from '../../lib/rag/prompt.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import type { RagDeps } from './deps.js';
import { querySchema } from './schemas.js';

/**
 * RAG 問い合わせ（POST /rag/query、ExApp 風 retrieve-and-generate）。上流契約 faithful：
 * 入力 {inputs:{question}}／出力 {outputs:<回答md>, usageMetadata}。検索（ハイブリッド）→ LLM で
 * 回答生成 → 参考情報を連結して 1 エンドポイントで返す。所有権は本人（auth.userId）にスコープ。
 *
 * usageMetadata は上流が LLM の usage 集計を載せる枠。現 LlmClient seam は usage を公開しないため
 * 空配列で返す（契約の形は保つ。usage 配線は LlmClient 拡張時に後続）。
 */
export function createQueryHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { inputs, model } = parseBody(querySchema, req.body);
    const requestId = currentRequestId();

    let resolvedModel: string;
    try {
      resolvedModel = resolveTextModel(model);
    } catch (error) {
      modelNotAllowedAsBadRequest(error);
    }

    const chunks = await deps.rag.retrieve(auth.userId, inputs.question, requestId);
    const answer = await deps.llm.generate({
      model: resolvedModel,
      messages: buildRagMessages(inputs.question, chunks),
      requestId: requestId ?? '',
    });

    return { status: 200, body: { outputs: composeAnswer(answer, chunks), usageMetadata: [] } };
  });
}

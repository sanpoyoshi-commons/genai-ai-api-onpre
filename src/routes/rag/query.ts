import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { composeAnswer } from '../../lib/rag/prompt.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import { resolveOwnedCollectionIds } from './collectionAccess.js';
import type { RagDeps } from './deps.js';
import { generateAnswer } from './generateAnswer.js';
import { querySchema } from './schemas.js';

/**
 * RAG 問い合わせ（POST /rag/query、ExApp 風 retrieve-and-generate）。上流契約 faithful：
 * 入力 {inputs:{question}}／出力 {outputs:<回答md>, usageMetadata}。検索（ハイブリッド）→ LLM で
 * 回答生成 → 参考情報を連結して 1 エンドポイントで返す。所有権は本人（auth.userId）にスコープ。
 *
 * usageMetadata は上流が LLM の usage 集計を載せる枠。現 LlmClient seam は usage を公開しないため
 * 空配列で返す（契約の形は保つ。usage 配線は LlmClient 拡張時に後続）。
 *
 * 対象のナレッジ集は `collectionIds` で絞れる（任意・上流契約の inputs は変えない）。未指定なら自分のすべて。
 * 検索と生成そのものは `/rag/ask` と同じ処理（generateAnswer）を通る。違うのは返す形だけ。
 */
export function createQueryHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { inputs, model, collectionIds } = parseBody(querySchema, req.body);
    const requestId = currentRequestId();
    const owned = await resolveOwnedCollectionIds(deps, auth.userId, collectionIds);

    const { answer, chunks } = await generateAnswer(deps, {
      ownerUserId: auth.userId,
      question: inputs.question,
      model,
      collectionIds: owned,
      requestId,
    });

    return { status: 200, body: { outputs: composeAnswer(answer, chunks), usageMetadata: [] } };
  });
}

import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { modelNotAllowedAsBadRequest, resolveTextModel } from '../../lib/llm/models.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import type { LawRagDeps } from './deps.js';
import { lawQuerySchema } from './schemas.js';

/**
 * 法令 RAG 問い合わせ（POST /law-rag/query・lawsy 忠実ポート）。
 *
 * 一般文書 RAG（/rag/query）と異なり、法令名ベース 4 段階（推定→特定→選別→レポート→出典結合）で
 * 引用付きレポートを生成する。法令データは全ユーザ共有のため owner スコープは持たない（認証は /api ゲートで必須）。
 * 出力契約は rag/query を踏襲：{outputs:<レポートmd>, usageMetadata}。usage は LlmClient seam 未公開のため空配列。
 */
export function createLawQueryHandler(deps: LawRagDeps): RequestHandler {
  return createApiHandler(async ({ req }) => {
    const { inputs, model } = parseBody(lawQuerySchema, req.body);
    const requestId = currentRequestId();

    let resolvedModel: string;
    try {
      resolvedModel = resolveTextModel(model);
    } catch (error) {
      modelNotAllowedAsBadRequest(error);
    }

    const report = await deps.pipeline.generateReport(
      inputs.question,
      resolvedModel,
      requestId ?? '',
    );

    return { status: 200, body: { outputs: report, usageMetadata: [] } };
  });
}

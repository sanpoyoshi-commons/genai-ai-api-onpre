import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import type { RagDeps } from './deps.js';
import { ingestSchema } from './schemas.js';

/**
 * 文書取り込み（POST /rag/documents、-onpre 新規）。C-4 チャンキング→本文全体 embedding→格納。
 * 所有権は本人（auth.userId）。返却は documentId と生成チャンク数。
 */
export function createIngestDocumentHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { title, text } = parseBody(ingestSchema, req.body);
    const result = await deps.rag.ingest(auth.userId, { title, text }, currentRequestId());
    return { status: 200, body: { documentId: result.documentId, chunkCount: result.chunkCount } };
  });
}

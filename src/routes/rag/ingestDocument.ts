import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import type { RagDeps } from './deps.js';
import { ingestSchema } from './schemas.js';

/**
 * 文書取り込み（POST /rag/documents、-onpre 新規）。C-4 チャンキング→本文全体 embedding→格納。
 * 所有権は本人（auth.userId）。返却は documentId と生成チャンク数。
 *
 * 画面が無かった時期からの経路で、互換のために残す。原本（Bronze）を持たないので、入った文書は
 * 作り直せない（画面がその旨を出す）。置き場は既定のナレッジ集（無ければ作る）。
 * 画面からの投入は `POST /rag/collections/:collectionId/documents`（原本を残す経路）を使う。
 */
export function createIngestDocumentHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { title, text } = parseBody(ingestSchema, req.body);
    const collectionId = await deps.knowledge.ensureDefaultCollection(auth.userId);
    const result = await deps.rag.ingest(
      auth.userId,
      {
        document: { collectionId, title, silverText: text, charCount: text.length },
        text,
      },
      currentRequestId(),
    );
    return { status: 200, body: { documentId: result.documentId, chunkCount: result.chunkCount } };
  });
}

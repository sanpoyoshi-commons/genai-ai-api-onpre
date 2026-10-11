import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { knowledgeObjectKey } from '../../lib/knowledge/objectKey.js';
import { requireKnowledgeBucket, requireOwnedCollection } from './collectionAccess.js';
import type { RagDeps } from './deps.js';
import { knowledgeUploadUrlSchema } from './schemas.js';

/** 署名付き URL の有効秒数（添付の `POST /file/url` と同じ 1 時間）。 */
const UPLOAD_URL_EXPIRES_IN = 3600;

/**
 * 原本（Bronze）への署名付き PUT URL（POST /rag/collections/:collectionId/uploads、-onpre 新規）。
 *
 * ブラウザはこの URL へ直にファイルを上げ、そのあと投入の API にキーを渡す（チャットの添付と同じ経路）。
 * **キーは api が決める**（所有者の sub を先頭に置く）＝クライアントに置き場を選ばせない。
 * 応答は署名付き URL の文字列（`POST /file/url` と同形。web は URL からキーを取り出して使う）。
 */
export function createKnowledgeUploadUrlHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    // 他人のナレッジ集へ上げる URL を出さない（投入の前にここでも所有を確かめる）。
    await requireOwnedCollection(deps, req, auth.userId);
    const bucket = requireKnowledgeBucket(deps);
    const { filename } = parseBody(knowledgeUploadUrlSchema, req.body);

    const key = knowledgeObjectKey(auth.userId, filename, 'document');
    const signedUrl = await deps.storage.presignUpload(bucket, key, UPLOAD_URL_EXPIRES_IN);
    return { status: 200, body: signedUrl };
  });
}

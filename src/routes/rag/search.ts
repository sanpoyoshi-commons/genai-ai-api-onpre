import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import { resolveOwnedCollectionIds } from './collectionAccess.js';
import type { RagDeps } from './deps.js';
import { searchSchema } from './schemas.js';

/**
 * 検索だけ（POST /rag/search、-onpre 新規）。**生成はしない。**
 *
 * 0 件は `{results: []}` を返す。文章で「該当なし」と返して呼ぶ側に文字列を突き合わせさせる作りにしない
 * （画面・ワークフロー・外のエージェントが同じ検索を使い回せるようにするため）。
 * 対象は本人の文書（auth.userId）。`collectionIds` で絞るときは、1 つでも自分のものでなければ 404。
 */
export function createSearchHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { query, collectionIds, topK } = parseBody(searchSchema, req.body);
    const owned = await resolveOwnedCollectionIds(deps, auth.userId, collectionIds);

    const results = await deps.rag.search(
      auth.userId,
      query,
      { collectionIds: owned, topK },
      currentRequestId(),
    );

    return {
      status: 200,
      body: {
        results: results.map((r) => ({
          documentId: r.documentId,
          title: r.documentTitle,
          collectionId: r.collectionId,
          chunkIndex: r.chunkIndex,
          headerPath: r.headerPath,
          text: r.chunkText,
          score: r.score,
          ...(r.rerankScore !== undefined ? { rerankScore: r.rerankScore } : {}),
        })),
      },
    };
  });
}

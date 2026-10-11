import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import { resolveOwnedCollectionIds } from './collectionAccess.js';
import type { RagDeps } from './deps.js';
import { generateAnswer } from './generateAnswer.js';
import { askSchema } from './schemas.js';

/**
 * 回答と参照を構造で返す（POST /rag/ask、-onpre 新規）。
 *
 * `/rag/query` は上流 ExApp 契約の形（`{outputs}`＝回答の末尾に出典を文字列で連結）なので、画面が
 * 「この引用の根拠はどのチャンクか」を知る手がかりが無い。本ルートは回答と参照を分けて返し、画面が
 * 引用番号にチャンク本文を結び付けられるようにする（法令調査の references と同じ考え方）。
 *
 * 検索・所有の絞り込み・生成は `/rag/query` と同じ処理（generateAnswer）を通る。参照の番号は
 * プロンプトに渡した並び順と同じ 1 起点＝回答中の `[1]` が references の n=1 に対応する。
 * チャンク本文はそのまま返す（画面が文字列として描画する。HTML として解釈させない）。
 */
export function createAskHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { question, model, collectionIds } = parseBody(askSchema, req.body);
    const requestId = currentRequestId();
    const owned = await resolveOwnedCollectionIds(deps, auth.userId, collectionIds);

    const { answer, chunks } = await generateAnswer(deps, {
      ownerUserId: auth.userId,
      question,
      model,
      collectionIds: owned,
      requestId,
    });

    return {
      status: 200,
      body: {
        answer,
        references: chunks.map((c, i) => ({
          n: i + 1,
          documentId: c.documentId,
          title: c.documentTitle,
          collectionId: c.collectionId,
          chunkIndex: c.chunkIndex,
          headerPath: c.headerPath,
          text: c.chunkText,
          score: c.score,
          ...(c.rerankScore !== undefined ? { rerankScore: c.rerankScore } : {}),
        })),
      },
    };
  });
}

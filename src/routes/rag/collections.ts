import type { RequestHandler } from 'express';
import { ApiError } from '../../lib/http/errors.js';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { parseBody } from '../../lib/http/validation.js';
import { getRequestLogger } from '../../middleware/requestContext.js';
import { CollectionNameConflictError, type CollectionRecord } from '../../repositories/ragRepository.js';
import { requireOwnedCollection } from './collectionAccess.js';
import type { RagDeps } from './deps.js';
import { collectionCreateSchema, collectionUpdateSchema } from './schemas.js';

/**
 * ナレッジ集の一覧・作成・名前の変更・削除（-onpre 新規）。所有権は本人（auth.userId）。
 * 他人の id を指定されたときは 404（在ることを漏らさない）。同じ名前は 409。
 */

/** 外に出す形（日時は ISO 文字列）。 */
function toBody(c: CollectionRecord) {
  return {
    collectionId: c.id,
    name: c.name,
    description: c.description,
    mcpEnabled: c.mcpEnabled,
    documentCount: c.documentCount,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function createListCollectionsHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ auth }) => {
    const collections = await deps.knowledge.listCollections(auth.userId);
    return { status: 200, body: { collections: collections.map(toBody) } };
  });
}

export function createCreateCollectionHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { name, description } = parseBody(collectionCreateSchema, req.body);
    try {
      const created = await deps.knowledge.createCollection({
        ownerUserId: auth.userId,
        name,
        description,
      });
      return { status: 201, body: toBody(created) };
    } catch (err) {
      if (err instanceof CollectionNameConflictError) {
        throw new ApiError(409, '同じ名前のナレッジ集があります。');
      }
      throw err;
    }
  });
}

export function createUpdateCollectionHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const collection = await requireOwnedCollection(deps, req, auth.userId);
    const patch = parseBody(collectionUpdateSchema, req.body);
    try {
      const updated = await deps.knowledge.updateCollection(auth.userId, collection.id, patch);
      if (!updated) {
        // 直前の確認との間に消えた場合（在らぬものは無い、として扱う）。
        throw new ApiError(404, 'ナレッジ集が見つかりません。');
      }
      return { status: 200, body: toBody(updated) };
    } catch (err) {
      if (err instanceof CollectionNameConflictError) {
        throw new ApiError(409, '同じ名前のナレッジ集があります。');
      }
      throw err;
    }
  });
}

/**
 * ナレッジ集を消す（中の文書も 3 層とも消す）。
 *
 * **DB を先に消し、原本のオブジェクトを後から消す。** 逆にすると、オブジェクトを消した後で DB の削除に
 * 失敗したときに「行はあるが原本が無い」文書が残り、作り直せないのに作り直せるように見える。
 * オブジェクトの削除に失敗した分はログに残す（取り残しを後から掃除する仕組みはまだ無い）。
 */
export function createDeleteCollectionHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const collection = await requireOwnedCollection(deps, req, auth.userId);
    const bronzeKeys = await deps.knowledge.deleteCollection(auth.userId, collection.id);
    if (bronzeKeys === undefined) {
      throw new ApiError(404, 'ナレッジ集が見つかりません。');
    }
    await deleteBronzeObjects(deps, bronzeKeys, collection.id);
    return { status: 204 };
  });
}

/** 原本のオブジェクトをまとめて消す（失敗は落とさずログに残す）。 */
export async function deleteBronzeObjects(
  deps: RagDeps,
  bronzeKeys: string[],
  context: string,
): Promise<void> {
  if (bronzeKeys.length === 0) {
    return;
  }
  const bucket = deps.buckets.knowledgeBucket;
  if (!bucket) {
    getRequestLogger().warn(
      {
        component: 'api.rag.knowledge',
        event: 'bronze_delete_skipped',
        context,
        keys: bronzeKeys.length,
      },
      'knowledge bucket is not configured; bronze objects were left behind',
    );
    return;
  }
  for (const key of bronzeKeys) {
    try {
      await deps.storage.deleteObject(bucket, key);
    } catch (err) {
      getRequestLogger().warn(
        {
          component: 'api.rag.knowledge',
          event: 'bronze_delete_failed',
          context,
          error: { message: err instanceof Error ? err.message : String(err) },
        },
        'failed to delete a bronze object; the row is already gone',
      );
    }
  }
}

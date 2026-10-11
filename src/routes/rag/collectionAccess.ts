import type { Request } from 'express';
import { notFound, serverError } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import type { CollectionRecord } from '../../repositories/ragRepository.js';
import type { RagDeps } from './deps.js';

/**
 * ナレッジ集の所有の確認。
 *
 * **他人の id を指定されたときは 404 を返す**（403 にしない）。403 は「在るが触れない」を伝えてしまい、
 * id を変えながら試せば他人のナレッジ集の有無が分かる。所有者から見て無いものは無い、として扱う。
 */
export async function requireOwnedCollection(
  deps: RagDeps,
  req: Request,
  ownerUserId: string,
): Promise<CollectionRecord> {
  const collectionId = requirePathParam(req, 'collectionId');
  const collection = await deps.knowledge.getCollection(ownerUserId, collectionId);
  if (!collection) {
    throw notFound('ナレッジ集が見つかりません。');
  }
  return collection;
}

/**
 * 検索の絞り込みに渡されたナレッジ集の id を突き合わせる。1 つでも自分のものでなければ 404。
 * 未指定・空配列は undefined（＝自分のすべてを対象にする）。
 */
export async function resolveOwnedCollectionIds(
  deps: RagDeps,
  ownerUserId: string,
  collectionIds: string[] | undefined,
): Promise<string[] | undefined> {
  if (!collectionIds || collectionIds.length === 0) {
    return undefined;
  }
  const requested = [...new Set(collectionIds)];
  const owned = await deps.knowledge.filterOwnedCollectionIds(ownerUserId, requested);
  if (owned.length !== requested.length) {
    throw notFound('ナレッジ集が見つかりません。');
  }
  return owned;
}

/** 原本（Bronze）のバケット。未設定は 500（deploy の配線漏れ＝利用者の入力の問題ではない）。 */
export function requireKnowledgeBucket(deps: RagDeps): string {
  const bucket = deps.buckets.knowledgeBucket;
  if (!bucket) {
    throw serverError('knowledge storage bucket is not configured');
  }
  return bucket;
}

/**
 * ストレージキーの所有権ヘルパ（上流 fileOwnership.ts のアイデア領域、MIT）。
 *
 * 上流はキー先頭セグメント（Cognito Identity ID）と要求者の Identity ID を突合する。ローカルは Keycloak に
 * Identity Pool 概念が無いため、所有者プレフィックス＝認証ユーザー（auth.userId / Keycloak sub）へ読み替える。
 * キー形＝`${userId}/${uuid}/${filename}`。純関数のため seam ではなく lib に置く。
 */

/** キー先頭セグメント（所有者識別子）を返す。空・先頭区切りのみは undefined。 */
export function extractKeyOwner(key: string): string | undefined {
  const [first] = key.split('/');
  return first ? first : undefined;
}

/** キーの所有者が要求ユーザーと一致するか。 */
export function authorizeOwnedKey(key: string, requestUserId: string): boolean {
  const owner = extractKeyOwner(key);
  return owner !== undefined && owner === requestUserId;
}

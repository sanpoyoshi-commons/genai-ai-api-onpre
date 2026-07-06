import type { JWTPayload } from 'jose';
import { unauthorized } from '../http/errors.js';

/**
 * requireAuth が検証済みトークンから req に注入する認証コンテキスト。
 * 上流の requestContext.authorizer.claims 構造を idea レベルで再現（識別子＋groups＋email）。
 */
export interface AuthContext {
  /** ユーザー識別子（Keycloak sub）。 */
  userId: string;
  /** cognito:groups 互換クレーム（Group Membership mapper）。 */
  groups: string[];
  email?: string;
  /** 検証済みクレーム全体（後続が必要なら参照）。 */
  claims: JWTPayload;
}

/**
 * groups クレームを配列へ正規化する。Group Membership mapper の配列出力と、
 * カンマ区切り文字列の両形を吸収する。
 */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((g): g is string => typeof g === 'string');
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
  }
  return [];
}

export function toAuthContext(payload: JWTPayload): AuthContext {
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  if (!sub) {
    throw unauthorized('token is missing a subject');
  }
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return {
    userId: sub,
    groups: parseGroups(payload['cognito:groups']),
    email,
    claims: payload,
  };
}

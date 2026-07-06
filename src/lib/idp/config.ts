/**
 * Keycloak Admin REST 連携の設定（env 読取、Admin REST 置換）。
 *
 * api はサービスアカウント client（client_credentials grant）で管理トークンを取得し、Admin REST で
 * ユーザー検索・グループ加入/離脱を行う。baseUrl/realm はコンテナ内部の非秘密固定値
 * （compose 既定値、requireAuth の KEYCLOAK_* と同思想）、clientSecret のみ秘密（docker secrets/env）。
 * clientSecret は `KEYCLOAK_ADMIN_CLIENT_SECRET_FILE`（docker secrets）優先・素の env フォールバック。
 * 未設定時は使用時（KeycloakIdpClient のメソッド呼び出し時）に例外＝該当ルート 500（seam 未配線と同挙動）。
 */
import { readSecretEnv } from '../secretEnv.js';
export interface KeycloakAdminConfig {
  /** Keycloak 内部ベース URL（例 http://keycloak:8080、/auth サフィックス無し）。 */
  baseUrl: string;
  /** realm 名（例 genai-realm）。 */
  realm: string;
  /** サービスアカウント client の clientId。 */
  clientId: string;
  /** サービスアカウント client の secret（秘密）。 */
  clientSecret: string;
}

export function loadKeycloakAdminConfig(): KeycloakAdminConfig {
  const baseUrl = process.env.KEYCLOAK_ADMIN_BASE_URL;
  const realm = process.env.KEYCLOAK_ADMIN_REALM;
  const clientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID;
  const clientSecret = readSecretEnv(process.env, 'KEYCLOAK_ADMIN_CLIENT_SECRET');
  if (!baseUrl || !realm || !clientId || !clientSecret) {
    throw new Error(
      'Keycloak admin env is not set (KEYCLOAK_ADMIN_BASE_URL / KEYCLOAK_ADMIN_REALM / KEYCLOAK_ADMIN_CLIENT_ID / KEYCLOAK_ADMIN_CLIENT_SECRET)',
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), realm, clientId, clientSecret };
}

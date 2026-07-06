import type { KeycloakAdminConfig } from './config.js';

/** fetch 互換（テストでモック注入できるよう型を切る）。 */
export type FetchFn = typeof fetch;

/** トークン有効期限の安全マージン（秒）。期限直前は再取得する。 */
const EXPIRY_SAFETY_SECONDS = 30;

/**
 * Keycloak Admin REST 用の管理トークン管理（サービスアカウント client_credentials grant）。
 * 取得したトークンを expires_in までキャッシュし、期限直前または強制更新時に再取得する。
 */
export class KeycloakAdminToken {
  private cached?: { token: string; expiresAtMs: number };

  constructor(
    private readonly config: KeycloakAdminConfig,
    private readonly fetchFn: FetchFn,
  ) {}

  /** 有効なトークンを返す（キャッシュ優先）。forceRefresh で強制再取得（401 復帰用）。 */
  async get(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.cached && this.cached.expiresAtMs > now) {
      return this.cached.token;
    }
    const url = `${this.config.baseUrl}/realms/${encodeURIComponent(this.config.realm)}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Keycloak admin token request failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Keycloak admin token response missing access_token');
    }
    const ttlMs = Math.max(0, (json.expires_in ?? 60) - EXPIRY_SAFETY_SECONDS) * 1000;
    this.cached = { token: json.access_token, expiresAtMs: now + ttlMs };
    return json.access_token;
  }
}

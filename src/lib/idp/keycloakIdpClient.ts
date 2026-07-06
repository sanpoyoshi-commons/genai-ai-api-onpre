import { type KeycloakAdminConfig, loadKeycloakAdminConfig } from './config.js';
import { type FetchFn, KeycloakAdminToken } from './keycloakAdminToken.js';
import type { IdpClient, IdpGroup, IdpUser } from './idpClient.js';

/**
 * 実 Keycloak Admin REST アダプタ。
 *
 * サービスアカウント client（client_credentials）で管理トークンを取得し、Admin REST で上流 Cognito API を置換する：
 * findUserByEmail＝GET users?email=&exact=true、addUserToGroup＝PUT users/{id}/groups/{gid}、removeUserFromGroup＝
 * DELETE 同（いずれも冪等）。group は名前→id を解決してキャッシュする。401 は 1 度だけトークン再取得して再試行する。
 * 設定（KEYCLOAK_ADMIN_*）は lazy 読取＝未配線時は使用時に例外（teams CRUD 500、seam 未配線と同挙動）。
 * fetch は注入可能（unit はモック注入）。realm は設計に追従（api が契約・groups.ts 定数＝Group 名 1:1）。
 */
export class KeycloakIdpClient implements IdpClient {
  private readonly groupIdCache = new Map<string, string>();
  private config?: KeycloakAdminConfig;
  private token?: KeycloakAdminToken;

  constructor(
    private readonly loadConfig: () => KeycloakAdminConfig = loadKeycloakAdminConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private cfg(): KeycloakAdminConfig {
    if (!this.config) {
      this.config = this.loadConfig();
      this.token = new KeycloakAdminToken(this.config, this.fetchFn);
    }
    return this.config;
  }

  /** Admin REST 呼び出し（Bearer 付与・401 は 1 度だけトークン再取得して再試行）。 */
  private async adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const cfg = this.cfg();
    const url = `${cfg.baseUrl}/admin/realms/${encodeURIComponent(cfg.realm)}${path}`;
    const call = async (forceRefresh: boolean): Promise<Response> => {
      const token = await this.token!.get(forceRefresh);
      return this.fetchFn(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      });
    };
    let res = await call(false);
    if (res.status === 401) {
      res = await call(true);
    }
    return res;
  }

  async findUserByEmail(email: string): Promise<IdpUser | null> {
    const res = await this.adminFetch(`/users?email=${encodeURIComponent(email)}&exact=true`);
    if (!res.ok) {
      throw new Error(`Keycloak findUserByEmail failed: ${res.status}`);
    }
    const users = (await res.json()) as Array<{ id?: string; email?: string }>;
    const user = users.find((u) => typeof u.id === 'string');
    if (!user?.id) {
      return null;
    }
    return { userId: user.id, email: user.email ?? email };
  }

  async addUserToGroup(userId: string, group: IdpGroup): Promise<void> {
    const groupId = await this.resolveGroupId(group);
    const res = await this.adminFetch(
      `/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(groupId)}`,
      { method: 'PUT' },
    );
    if (!res.ok) {
      throw new Error(`Keycloak addUserToGroup failed: ${res.status}`);
    }
  }

  async removeUserFromGroup(userId: string, group: IdpGroup): Promise<void> {
    const groupId = await this.resolveGroupId(group);
    const res = await this.adminFetch(
      `/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(groupId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      throw new Error(`Keycloak removeUserFromGroup failed: ${res.status}`);
    }
  }

  /** グループ名→id を解決（トップレベル group 3 個・名前完全一致）。id はキャッシュする。 */
  private async resolveGroupId(name: IdpGroup): Promise<string> {
    const cached = this.groupIdCache.get(name);
    if (cached) {
      return cached;
    }
    const res = await this.adminFetch(`/groups?search=${encodeURIComponent(name)}`);
    if (!res.ok) {
      throw new Error(`Keycloak group lookup failed: ${res.status}`);
    }
    const groups = (await res.json()) as Array<{ id?: string; name?: string }>;
    const match = groups.find((g) => g.name === name && typeof g.id === 'string');
    if (!match?.id) {
      throw new Error(`Keycloak group not found: ${name}`);
    }
    this.groupIdCache.set(name, match.id);
    return match.id;
  }
}

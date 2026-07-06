/**
 * Keycloak access token 検証の設定（env 読取）。未設定は起動時 fail させる（無設定起動の防止）。
 * 検証は jose の標準 JWKS 自前検証（client adapter 不使用）。
 */
export interface AuthConfig {
  /** 期待する iss（realm URL）。 */
  issuer: string;
  /** JWKS エンドポイント（/realms/<realm>/protocol/openid-connect/certs）。 */
  jwksUri: string;
  /** aud 厳格検証の期待値（Custom Audience の api 論理名）。 */
  audience: string;
}

export function loadAuthConfig(): AuthConfig {
  const issuer = process.env.KEYCLOAK_ISSUER;
  const jwksUri = process.env.KEYCLOAK_JWKS_URI;
  const audience = process.env.KEYCLOAK_AUDIENCE;
  if (!issuer || !jwksUri || !audience) {
    throw new Error('Keycloak auth env is not set (KEYCLOAK_ISSUER / KEYCLOAK_JWKS_URI / KEYCLOAK_AUDIENCE)');
  }
  return { issuer, jwksUri, audience };
}

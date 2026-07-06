import type { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { loadAuthConfig } from '../lib/auth/config.js';
import { toAuthContext } from '../lib/auth/context.js';
import { ApiError, unauthorized } from '../lib/http/errors.js';
import { getRequestLogger } from './requestContext.js';

const AUTH_COMPONENT = 'api.auth';

/**
 * 認証ミドルウェア。上流の API Gateway Cognito Authorizer を 1:1 代替し、
 * Bearer 抽出 → Keycloak realm JWKS で署名検証 + iss/exp/aud 厳格検証 → 検証済みクレームを
 * req.auth へ注入する。aud は Custom Audience を厳格に要求する。
 * 検証ライブラリは jose（client adapter 不使用）。
 */
type VerifyKey = Parameters<typeof jwtVerify>[1];

interface VerifyOptions {
  issuer: string;
  audience: string;
}

function extractBearer(header: string | undefined): string {
  if (!header) {
    throw unauthorized('missing Authorization header');
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw unauthorized('malformed Authorization header');
  }
  return token;
}

/**
 * 検証鍵（リモート JWKS またはテスト鍵）と iss/aud を受け取り requireAuth を生成する。
 * jwtVerify が署名・iss・aud・exp を一括検証する。
 */
export function createRequireAuth(key: VerifyKey, options: VerifyOptions): RequestHandler {
  return (req, _res, next) => {
    const log = getRequestLogger().child({ component: AUTH_COMPONENT });
    (async () => {
      const token = extractBearer(req.headers.authorization);
      const { payload } = await jwtVerify(token, key, {
        issuer: options.issuer,
        audience: options.audience,
      });
      req.auth = toAuthContext(payload);
      log.info(
        { event: 'login_succeeded', user_id: req.auth.userId, groups: req.auth.groups },
        'login succeeded',
      );
    })()
      .then(() => next())
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(
          { event: 'auth_token_rejected', error: { message: reason } },
          'authentication rejected',
        );
        next(err instanceof ApiError ? err : unauthorized('authentication failed'));
      });
  };
}

/** env（KEYCLOAK_*）から本番用 requireAuth を構築する。JWKS はキャッシュ＋ローテーション対応。 */
export function requireAuthFromEnv(): RequestHandler {
  const config = loadAuthConfig();
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  return createRequireAuth(jwks, { issuer: config.issuer, audience: config.audience });
}

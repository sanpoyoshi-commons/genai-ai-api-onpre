import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp } from './app.js';
import { configureGlobalHttpTimeouts } from './lib/http/undiciConfig.js';
import { logger } from './lib/logger.js';
import { requireAuthFromEnv } from './middleware/requireAuth.js';
import { createApiRouterFromEnv } from './routes/apiRouter.js';

// fetch(undici) の既定 300s タイムアウトを延長（CPU 推論の重い生成が prefill 中に切られるのを防ぐ）。
// 他の import 由来の fetch 呼び出しより前に設定する。
configureGlobalHttpTimeouts();

// /api は全ルート共通 requireAuth ゲート配下。env（KEYCLOAK_*）未設定なら起動時 fail。
const app = createApp({ apiGate: requireAuthFromEnv(), apiRouter: createApiRouterFromEnv() });

// 内部 TLS（nginx↔api）。TLS_CERT/TLS_KEY が与えられた場合は HTTPS、
// 無い場合は HTTP で待受（単体起動・後方互換）。証明書は deploy リポが ./certs から
// read-only マウント（docker-compose.yml）。
const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;

let server: http.Server | https.Server;

if (tlsCert && tlsKey) {
  const port = Number(process.env.TLS_PORT ?? 3443);
  server = https
    .createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, app)
    .listen(port, () => {
      logger.info({ port, tls: true }, 'genai-ai-api-onpre listening (HTTPS)');
    });
} else {
  const port = Number(process.env.PORT ?? 3000);
  server = http.createServer(app).listen(port, () => {
    logger.info({ port, tls: false }, 'genai-ai-api-onpre listening (HTTP)');
  });
}

// graceful shutdown（docker compose stop / SIGTERM）
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}

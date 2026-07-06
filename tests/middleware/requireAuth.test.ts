import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { type CryptoKey, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../../src/app.js';
import { createApiHandler } from '../../src/lib/http/createApiHandler.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';

const ISSUER = 'https://localhost/auth/realms/genai-realm';
const AUDIENCE = 'genai-ai-api';

let server: Server;
let baseUrl: string;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;

async function mint(options: {
  key?: CryptoKey;
  issuer?: string;
  audience?: string;
  sub?: string;
  groups?: unknown;
  expSeconds?: number;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  if (options.groups !== undefined) {
    payload['cognito:groups'] = options.groups;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(options.sub ?? 'user-123')
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(options.expSeconds ?? now + 300)
    .sign(options.key ?? privateKey);
}

before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const other = await generateKeyPair('RS256');
  otherPrivateKey = other.privateKey;

  const apiRouter = express.Router();
  apiRouter.get(
    '/whoami',
    createApiHandler(async ({ auth }) => ({
      status: 200,
      body: { userId: auth.userId, groups: auth.groups, email: auth.email },
    })),
  );

  const app = createApp({
    apiGate: createRequireAuth(pair.publicKey, { issuer: ISSUER, audience: AUDIENCE }),
    apiRouter,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
});

test('有効なトークンは 200 と claims（sub/groups/email）を返す', async () => {
  const token = await mint({ groups: ['User', 'TeamAdmin'], sub: 'u-1' });
  const res = await fetch(`${baseUrl}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { userId: string; groups: string[]; email?: string };
  assert.equal(body.userId, 'u-1');
  assert.deepEqual(body.groups, ['User', 'TeamAdmin']);
});

test('groups がカンマ区切り文字列でも配列に正規化される', async () => {
  const token = await mint({ groups: 'User,SystemAdmin' });
  const res = await fetch(`${baseUrl}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { groups: string[] };
  assert.deepEqual(body.groups, ['User', 'SystemAdmin']);
});

test('Authorization ヘッダ無しは 401', async () => {
  const res = await fetch(`${baseUrl}/api/whoami`);
  assert.equal(res.status, 401);
});

test('署名鍵が異なるトークンは 401', async () => {
  const token = await mint({ key: otherPrivateKey });
  const res = await fetch(`${baseUrl}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

test('aud 不一致は 401（Custom Audience 厳格検証）', async () => {
  const token = await mint({ audience: 'wrong-audience' });
  const res = await fetch(`${baseUrl}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

test('iss 不一致は 401', async () => {
  const token = await mint({ issuer: 'https://evil.example/realms/x' });
  const res = await fetch(`${baseUrl}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

test('期限切れトークンは 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await mint({ expSeconds: now - 60 });
  const res = await fetch(`${baseUrl}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

test('X-Request-ID は受信ヘッダを尊重してエコーされる', async () => {
  const token = await mint();
  const res = await fetch(`${baseUrl}/api/whoami`, {
    headers: { authorization: `Bearer ${token}`, 'x-request-id': 'fixed-req-id-001' },
  });
  assert.equal(res.headers.get('x-request-id'), 'fixed-req-id-001');
});

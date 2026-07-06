import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { KeycloakAdminConfig } from '../../src/lib/idp/config.js';
import { KeycloakIdpClient } from '../../src/lib/idp/keycloakIdpClient.js';

const config: KeycloakAdminConfig = {
  baseUrl: 'http://keycloak:8080',
  realm: 'genai-realm',
  clientId: 'genai-ai-api-admin',
  clientSecret: 'dev-secret',
};

type Call = { url: string; method: string };
let calls: Call[] = [];

/** 経路別の応答を返すモック fetch。tokenStatus で 1 回目 401→2 回目 200 を再現できる。 */
function makeFetch(opts: { firstUsersUnauthorized?: boolean } = {}) {
  let usersHit = 0;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });

    if (url.endsWith('/protocol/openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 300 }), { status: 200 });
    }
    if (url.includes('/users?email=')) {
      usersHit += 1;
      if (opts.firstUsersUnauthorized && usersHit === 1) {
        return new Response('', { status: 401 });
      }
      const email = decodeURIComponent(url.split('email=')[1].split('&')[0]);
      const body = email === 'known@e.jp' ? [{ id: 'user-1', email }] : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes('/groups?search=')) {
      const name = decodeURIComponent(url.split('search=')[1].split('&')[0]);
      return new Response(JSON.stringify([{ id: `gid-${name}`, name }]), { status: 200 });
    }
    if (url.includes('/groups/')) {
      return new Response(null, { status: 204 }); // PUT/DELETE membership（204 は null body 必須）
    }
    return new Response('not found', { status: 404 });
  };
}

const newClient = (fetchFn: typeof fetch) => new KeycloakIdpClient(() => config, fetchFn);

beforeEach(() => {
  calls = [];
});

test('findUserByEmail: 在籍は {userId,email}、不在は null', async () => {
  const idp = newClient(makeFetch() as typeof fetch);
  assert.deepEqual(await idp.findUserByEmail('known@e.jp'), { userId: 'user-1', email: 'known@e.jp' });
  assert.equal(await idp.findUserByEmail('nobody@e.jp'), null);
});

test('token はキャッシュされ複数操作で 1 回だけ取得', async () => {
  const idp = newClient(makeFetch() as typeof fetch);
  await idp.findUserByEmail('known@e.jp');
  await idp.findUserByEmail('nobody@e.jp');
  const tokenCalls = calls.filter((c) => c.url.endsWith('/protocol/openid-connect/token'));
  assert.equal(tokenCalls.length, 1);
});

test('addUserToGroup: group 名→id 解決して PUT、id はキャッシュ', async () => {
  const idp = newClient(makeFetch() as typeof fetch);
  await idp.addUserToGroup('user-1', 'TeamAdmin');
  await idp.addUserToGroup('user-2', 'TeamAdmin');

  const groupLookups = calls.filter((c) => c.url.includes('/groups?search='));
  assert.equal(groupLookups.length, 1); // 2 回目はキャッシュ
  const puts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/groups/gid-TeamAdmin'));
  assert.equal(puts.length, 2);
  assert.match(puts[0].url, /\/users\/user-1\/groups\/gid-TeamAdmin$/);
});

test('removeUserFromGroup: DELETE を発行', async () => {
  const idp = newClient(makeFetch() as typeof fetch);
  await idp.removeUserFromGroup('user-1', 'TeamAdmin');
  const dels = calls.filter((c) => c.method === 'DELETE');
  assert.equal(dels.length, 1);
  assert.match(dels[0].url, /\/users\/user-1\/groups\/gid-TeamAdmin$/);
});

test('401 はトークン再取得して 1 度だけ再試行', async () => {
  const idp = newClient(makeFetch({ firstUsersUnauthorized: true }) as typeof fetch);
  const user = await idp.findUserByEmail('known@e.jp');
  assert.deepEqual(user, { userId: 'user-1', email: 'known@e.jp' });
  const tokenCalls = calls.filter((c) => c.url.endsWith('/protocol/openid-connect/token'));
  assert.equal(tokenCalls.length, 2); // 初回＋強制リフレッシュ
});

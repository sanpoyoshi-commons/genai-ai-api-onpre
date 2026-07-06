import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertAllowedEndpoint,
  EndpointNotAllowedError,
  isLocalOrPrivateHost,
} from '../../src/lib/exapp/endpointSecurity.js';

const denyAll = { allowPrivateEndpoints: false, allowlist: [] };

test('isLocalOrPrivateHost classifies local/private', () => {
  for (const h of ['localhost', 'foo.localhost', 'host.docker.internal', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.1.1', '::1', 'echo']) {
    assert.equal(isLocalOrPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', 'api.example.co.jp', '172.32.0.1']) {
    assert.equal(isLocalOrPrivateHost(h), false, h);
  }
});

test('public endpoint is allowed by default', () => {
  const url = assertAllowedEndpoint('https://api.example.com/requests', denyAll);
  assert.equal(url.hostname, 'api.example.com');
});

test('private endpoint blocked by default', () => {
  assert.throws(() => assertAllowedEndpoint('http://localhost:8080/x', denyAll), EndpointNotAllowedError);
});

test('private endpoint allowed when opt-in + allowlist matches host', () => {
  const policy = { allowPrivateEndpoints: true, allowlist: ['localhost', 'echo-app'] };
  assert.ok(assertAllowedEndpoint('http://localhost:8080/x', policy));
  assert.ok(assertAllowedEndpoint('http://echo-app:3000/run', policy));
});

test('private endpoint blocked when opt-in but host not in allowlist', () => {
  const policy = { allowPrivateEndpoints: true, allowlist: ['localhost'] };
  assert.throws(() => assertAllowedEndpoint('http://192.168.0.9/x', policy), EndpointNotAllowedError);
});

test('CIDR allowlist matches IPv4', () => {
  const policy = { allowPrivateEndpoints: true, allowlist: ['192.168.0.0/24'] };
  assert.ok(assertAllowedEndpoint('http://192.168.0.42/x', policy));
  assert.throws(() => assertAllowedEndpoint('http://192.168.1.42/x', policy), EndpointNotAllowedError);
});

test('non-http protocol rejected', () => {
  assert.throws(() => assertAllowedEndpoint('file:///etc/passwd', denyAll), EndpointNotAllowedError);
  assert.throws(() => assertAllowedEndpoint('ftp://example.com/x', denyAll), EndpointNotAllowedError);
});

test('invalid URL rejected', () => {
  assert.throws(() => assertAllowedEndpoint('not a url', denyAll), EndpointNotAllowedError);
});

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { FileStorage, PresignDownloadOptions } from '../../src/lib/storage/fileStorage.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createFilesRouter } from '../../src/routes/files/index.js';

// ── fake FileStorage（呼び出しを記録して固定 URL を返す） ──
let uploadCalls: Array<{ bucket: string; key: string }> = [];
let downloadCalls: Array<{ bucket: string; key: string; options: PresignDownloadOptions }> = [];
let deleteCalls: Array<{ bucket: string; key: string }> = [];
const fakeStorage: FileStorage = {
  async presignUpload(bucket, key) {
    uploadCalls.push({ bucket, key });
    return `https://storage.example/upload/${key}`;
  },
  async presignDownload(bucket, key, options) {
    downloadCalls.push({ bucket, key, options });
    return `https://storage.example/download/${key}`;
  },
  async getObject() {
    return new Uint8Array();
  },
  async deleteObject(bucket, key) {
    deleteCalls.push({ bucket, key });
  },
};

let server: Server | undefined;
let baseUrl: string;
let currentAuth: AuthContext;

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use('/api', createFilesRouter({ storage: fakeStorage, buckets: { fileBucket: 'files' } }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server?.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => server?.close());

beforeEach(() => {
  uploadCalls = [];
  downloadCalls = [];
  deleteCalls = [];
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

test('upload: userId プレフィックス付きキーで署名 URL を返す', async () => {
  const res = await api('/file/url', { method: 'POST', body: JSON.stringify({ filename: 'a.png', mediaFormat: 'png' }) });
  assert.equal(res.status, 200);
  assert.match(await res.json(), /^https:\/\/storage\.example\/upload\//);
  assert.equal(uploadCalls.length, 1);
  assert.match(uploadCalls[0].key, /^u1\/[0-9a-f-]+\/a\.png$/);
  assert.equal(uploadCalls[0].bucket, 'files');
});

test('download: 本人のキーは 200・他人のキーは 403', async () => {
  const ok = await api('/file/url?filePrefix=u1/x/a.png&contentType=image/png');
  assert.equal(ok.status, 200);
  assert.equal(downloadCalls[0].options.responseContentType, 'image/png');

  const ng = await api('/file/url?filePrefix=other/x/a.png');
  assert.equal(ng.status, 403);
});

test('delete: 本人のキーは 204・他人のキーは 403', async () => {
  const ok = await api(`/file/${encodeURIComponent('u1/x/a.png')}`, { method: 'DELETE' });
  assert.equal(ok.status, 204);
  assert.deepEqual(deleteCalls, [{ bucket: 'files', key: 'u1/x/a.png' }]);

  const ng = await api(`/file/${encodeURIComponent('other/x/a.png')}`, { method: 'DELETE' });
  assert.equal(ng.status, 403);
  assert.equal(deleteCalls.length, 1);
});

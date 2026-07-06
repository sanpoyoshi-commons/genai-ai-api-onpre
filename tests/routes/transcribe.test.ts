import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { FileStorage } from '../../src/lib/storage/fileStorage.js';
import type {
  StartTranscriptionInput,
  TranscriptionClient,
  TranscriptionJob,
} from '../../src/lib/transcription/transcriptionClient.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createTranscribeRouter } from '../../src/routes/transcribe/index.js';

let startCalls: StartTranscriptionInput[] = [];
const jobs = new Map<string, TranscriptionJob>();
const fakeTranscription: TranscriptionClient = {
  async startJob(input) {
    startCalls.push(input);
    return { jobName: 'job-1' };
  },
  async getJob(jobName) {
    return jobs.get(jobName) ?? null;
  },
};

const fakeStorage: FileStorage = {
  async presignUpload(_bucket, key) {
    return `https://storage.example/upload/${key}`;
  },
  async presignDownload(_bucket, key) {
    return `https://storage.example/download/${key}`;
  },
  async getObject() {
    return new Uint8Array();
  },
  async deleteObject() {},
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
  app.use(
    '/api',
    createTranscribeRouter({ transcription: fakeTranscription, storage: fakeStorage, buckets: { audioBucket: 'audio' } }),
  );
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
  startCalls = [];
  jobs.clear();
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

test('start: 本人の audioKey は jobName を返す・他人のキーは 403', async () => {
  const ok = await api('/transcribe/start', {
    method: 'POST',
    body: JSON.stringify({ audioKey: 'u1/x/a.mp3', speakerLabel: true, maxSpeakers: 2 }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { jobName: 'job-1' });
  assert.equal(startCalls[0].userId, 'u1');

  const ng = await api('/transcribe/start', {
    method: 'POST',
    body: JSON.stringify({ audioKey: 'other/x/a.mp3', speakerLabel: false, maxSpeakers: 1 }),
  });
  assert.equal(ng.status, 403);
});

test('url: audio バケットへアップロード署名 URL を返す', async () => {
  const res = await api('/transcribe/url', { method: 'POST', body: JSON.stringify({ filename: 'a.mp3', mediaFormat: 'mp3' }) });
  assert.equal(res.status, 200);
  assert.match(await res.json(), /^https:\/\/storage\.example\/upload\/u1\//);
});

test('result: COMPLETED は transcripts を返す', async () => {
  jobs.set('job-1', {
    jobName: 'job-1',
    ownerUserId: 'u1',
    status: 'COMPLETED',
    languageCode: 'ja-JP',
    transcripts: [{ speakerLabel: 'spk_0', transcript: 'こんにちは' }],
  });
  const res = await api('/transcribe/result/job-1');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: 'COMPLETED',
    languageCode: 'ja-JP',
    transcripts: [{ speakerLabel: 'spk_0', transcript: 'こんにちは' }],
  });
});

test('result: 他人のジョブは 403・不在は 404', async () => {
  jobs.set('job-1', { jobName: 'job-1', ownerUserId: 'owner', status: 'IN_PROGRESS' });
  const forbidden = await api('/transcribe/result/job-1');
  assert.equal(forbidden.status, 403);

  const missing = await api('/transcribe/result/job-x');
  assert.equal(missing.status, 404);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { SeaweedFsStorage } from '../../src/lib/storage/seaweedFsStorage.js';

const PUBLIC_ENDPOINT = 'https://s3.example.test';

// presign は純 SigV4 計算（network 不要）なので実 client を注入する。
function realPublicClient(): S3Client {
  return new S3Client({
    endpoint: PUBLIC_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    forcePathStyle: true,
  });
}

// delete はサーバ側 IO。send を捕捉/差し替えできる fake を注入する。
function fakeInternalClient(send: (command: unknown) => Promise<unknown>): S3Client {
  return { send } as unknown as S3Client;
}

test('presignUpload は公開エンドポイントの path-style 署名 URL を返す', async () => {
  const storage = new SeaweedFsStorage({ publicClient: realPublicClient() });
  const url = await storage.presignUpload('my-bucket', 'user-1/uuid/foo.txt', 3600);
  const parsed = new URL(url);

  assert.equal(parsed.origin, PUBLIC_ENDPOINT); // ブラウザ到達用ホストで署名（SigV4 host 一致）
  assert.equal(parsed.pathname, '/my-bucket/user-1/uuid/foo.txt'); // path-style（bucket がパス先頭）
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '3600');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.ok(parsed.searchParams.get('X-Amz-Signature'));
  assert.ok(parsed.searchParams.get('X-Amz-Algorithm'));
});

test('presignDownload は content-type / content-disposition をクエリに反映する', async () => {
  const storage = new SeaweedFsStorage({ publicClient: realPublicClient() });
  const url = await storage.presignDownload('arts', 'user-1/uuid/report.pdf', {
    expiresIn: 60,
    responseContentType: 'application/pdf',
    responseContentDisposition: 'attachment',
  });
  const parsed = new URL(url);

  assert.equal(parsed.pathname, '/arts/user-1/uuid/report.pdf');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '60');
  assert.equal(parsed.searchParams.get('response-content-type'), 'application/pdf');
  assert.equal(parsed.searchParams.get('response-content-disposition'), 'attachment');
  assert.ok(parsed.searchParams.get('X-Amz-Signature'));
});

test('presignDownload は応答上書き未指定でも署名 URL を返す', async () => {
  const storage = new SeaweedFsStorage({ publicClient: realPublicClient() });
  const url = await storage.presignDownload('b', 'user-1/uuid/x', { expiresIn: 60 });
  const parsed = new URL(url);

  assert.equal(parsed.pathname, '/b/user-1/uuid/x');
  assert.equal(parsed.searchParams.get('response-content-type'), null);
  assert.equal(parsed.searchParams.get('response-content-disposition'), null);
});

test('deleteObject は内部 client へ Bucket/Key を渡して送信する', async () => {
  let captured: { Bucket?: string; Key?: string } | undefined;
  const storage = new SeaweedFsStorage({
    internalClient: fakeInternalClient(async (command) => {
      captured = (command as { input: { Bucket?: string; Key?: string } }).input;
      return {};
    }),
  });

  await storage.deleteObject('my-bucket', 'user-1/uuid/foo.txt');
  assert.deepEqual(captured, { Bucket: 'my-bucket', Key: 'user-1/uuid/foo.txt' });
});

test('deleteObject は NoSuchKey / 404 を冪等に握り潰す', async () => {
  const byName = new SeaweedFsStorage({
    internalClient: fakeInternalClient(async () => {
      throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    }),
  });
  await assert.doesNotReject(() => byName.deleteObject('b', 'k'));

  const byStatus = new SeaweedFsStorage({
    internalClient: fakeInternalClient(async () => {
      throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
    }),
  });
  await assert.doesNotReject(() => byStatus.deleteObject('b', 'k'));
});

test('deleteObject はその他のエラーを伝播する', async () => {
  const storage = new SeaweedFsStorage({
    internalClient: fakeInternalClient(async () => {
      throw Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } });
    }),
  });
  await assert.rejects(() => storage.deleteObject('b', 'k'), /boom/);
});

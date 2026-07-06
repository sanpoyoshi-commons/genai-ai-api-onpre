import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadS3Config } from '../../src/lib/storage/s3Config.js';

const CREDS = { S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' };

test('loadS3Config は非秘密を既定値で埋め creds を採用する', () => {
  const config = loadS3Config({ ...CREDS } as NodeJS.ProcessEnv);
  assert.equal(config.internalEndpoint, 'http://seaweedfs:8333');
  assert.equal(config.region, 'us-east-1');
  assert.equal(config.publicEndpoint, undefined); // 未設定は undefined（presign 利用時に明示エラー）
  assert.equal(config.accessKeyId, 'key');
  assert.equal(config.secretAccessKey, 'secret');
});

test('loadS3Config は env の上書きを反映する', () => {
  const config = loadS3Config({
    ...CREDS,
    S3_PUBLIC_ENDPOINT: 'https://s3.example.test',
    S3_INTERNAL_ENDPOINT: 'http://seaweed:9000',
    S3_REGION: 'jp-east',
  } as NodeJS.ProcessEnv);
  assert.equal(config.publicEndpoint, 'https://s3.example.test');
  assert.equal(config.internalEndpoint, 'http://seaweed:9000');
  assert.equal(config.region, 'jp-east');
});

test('loadS3Config は creds 未設定で明示エラー', () => {
  assert.throws(() => loadS3Config({} as NodeJS.ProcessEnv), /S3_ACCESS_KEY_ID/);
  assert.throws(
    () => loadS3Config({ S3_ACCESS_KEY_ID: 'key' } as NodeJS.ProcessEnv),
    /S3_SECRET_ACCESS_KEY/,
  );
});

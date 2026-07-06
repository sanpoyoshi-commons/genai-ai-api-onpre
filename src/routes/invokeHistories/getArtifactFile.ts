import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest, forbidden, serverError } from '../../lib/http/errors.js';
import { requireQueryParam } from '../../lib/http/validation.js';
import { extractKeyOwner } from '../../lib/storage/ownership.js';
import type { InvokeHistoriesDeps } from './deps.js';

const ARTIFACT_URL_EXPIRES_IN = 3600;

/** ストレージ URL からバケット名とキーを取得（s3://bucket/key、または https://bucket.s3...amazonaws.com/key）。 */
function parseStorageUrl(url: string): { bucketName: string; key: string } | null {
  const match =
    /^s3:\/\/(?<bucketName>[^/]+)\/(?<key>.+)$/.exec(url) ??
    /^https:\/\/(?<bucketName>[^.]+)\.s3[^/]*\.amazonaws\.com\/(?<key>.+)$/.exec(url);
  const bucketName = match?.groups?.bucketName;
  const key = match?.groups?.key;
  if (!bucketName || !key) {
    return null;
  }
  return { bucketName, key };
}

/**
 * getArtifactFile（GET /exapps/artifact-file、MIT 移植）。ExApp アーティファクトのダウンロード署名 URL を返す。
 *
 * s3Url をパースし、許可バケット（artifacts）限定・キー先頭セグメントの所有権（auth.userId 一致）を確認してから
 * 署名する。上流は Cognito Identity ID で所有権判定したが、ローカルは auth.userId へ読み替える。
 * 不正 URL は 400、他バケット/他人のファイルは 403、バケット未設定は 500。応答は { data: signedUrl }。
 * エラー応答形は統一（{error}）に正規化する（上流の手書き {message} とは別）。
 */
export function createGetArtifactFileHandler(deps: InvokeHistoriesDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const s3Url = requireQueryParam(req, 's3Url');

    const parsed = parseStorageUrl(decodeURIComponent(s3Url));
    if (!parsed) {
      throw badRequest('Invalid storage URL format');
    }

    const { artifactsBucket } = deps.buckets;
    if (!artifactsBucket) {
      throw serverError('artifacts storage bucket is not configured');
    }
    if (parsed.bucketName !== artifactsBucket) {
      throw forbidden('Access to this bucket is not allowed');
    }

    const owner = extractKeyOwner(parsed.key);
    if (!owner) {
      throw badRequest('Invalid file path format');
    }
    if (owner !== auth.userId) {
      throw forbidden('Access denied: You can only access your own files');
    }

    const signedUrl = await deps.storage.presignDownload(artifactsBucket, parsed.key, {
      expiresIn: ARTIFACT_URL_EXPIRES_IN,
      responseContentDisposition: 'attachment',
    });
    return { status: 200, body: { data: signedUrl } };
  });
}

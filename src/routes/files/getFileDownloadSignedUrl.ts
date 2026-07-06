import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { forbidden, serverError } from '../../lib/http/errors.js';
import { getQueryParam, requireQueryParam } from '../../lib/http/validation.js';
import { authorizeOwnedKey } from '../../lib/storage/ownership.js';
import type { FilesDeps } from './deps.js';

const DOWNLOAD_URL_EXPIRES_IN = 60;

/**
 * ダウンロード署名 URL（GET /file/url、MIT 移植）。filePrefix で対象を指定し、所有権（プレフィックス一致）を
 * 確認してから署名する。`bucketName`/`region` クエリはフロント後方互換で受理するが無視し、常に自バケットに
 * 限定する（cross-bucket 防止）。所有権違反は 403、バケット未設定は 500。
 */
export function createGetDownloadUrlHandler(deps: FilesDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const filePrefix = requireQueryParam(req, 'filePrefix');
    const contentType = getQueryParam(req, 'contentType');

    if (!deps.buckets.fileBucket) {
      throw serverError('file storage bucket is not configured');
    }
    if (!authorizeOwnedKey(filePrefix, auth.userId)) {
      throw forbidden('Access denied: You can only access your own files');
    }

    const signedUrl = await deps.storage.presignDownload(deps.buckets.fileBucket, filePrefix, {
      expiresIn: DOWNLOAD_URL_EXPIRES_IN,
      responseContentType: contentType,
    });
    return { status: 200, body: signedUrl };
  });
}

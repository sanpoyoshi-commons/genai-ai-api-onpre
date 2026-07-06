import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { serverError } from '../../lib/http/errors.js';
import { parseBody } from '../../lib/http/validation.js';
import type { FileStorage } from '../../lib/storage/fileStorage.js';
import { uploadUrlSchema } from './schemas.js';

const UPLOAD_URL_EXPIRES_IN = 3600;

/**
 * アップロード署名 URL（POST /file/url、MIT 移植）。/transcribe/url でも audio バケットへ流用する。
 *
 * キーは `${userId}/${uuid}/${filename}`。上流は Cognito Identity ID をプレフィックスにしたが、ローカルは
 * 認証ユーザー（auth.userId）に読み替える。バケット名は呼び出し側が解決して渡す
 * （未設定は 500）。署名計算は FileStorage seam（実 SeaweedFS は後続）。応答は署名 URL 文字列。
 */
export function createUploadUrlHandler(storage: FileStorage, bucket: string | undefined): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { filename } = parseBody(uploadUrlSchema, req.body);
    if (!bucket) {
      throw serverError('file storage bucket is not configured');
    }
    const name = filename && filename.length > 0 ? filename : randomUUID();
    const key = `${auth.userId}/${randomUUID()}/${name}`;
    const signedUrl = await storage.presignUpload(bucket, key, UPLOAD_URL_EXPIRES_IN);
    return { status: 200, body: signedUrl };
  });
}

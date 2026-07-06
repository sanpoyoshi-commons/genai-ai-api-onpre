import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { forbidden, serverError } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import { authorizeOwnedKey } from '../../lib/storage/ownership.js';
import type { FilesDeps } from './deps.js';

/**
 * ファイル削除（DELETE /file/{fileName}、MIT 移植）。fileName は URL エンコードされた S3 キー。Express は
 * パスパラメータを自動デコードしないため明示デコードして元キーへ戻す（上流同様）。所有権（プレフィックス一致）を
 * 確認してから削除。違反は 403、バケット未設定は 500。冪等に 204。
 */
export function createDeleteFileHandler(deps: FilesDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const fileName = decodeURIComponent(requirePathParam(req, 'fileName'));

    if (!deps.buckets.fileBucket) {
      throw serverError('file storage bucket is not configured');
    }
    if (!authorizeOwnedKey(fileName, auth.userId)) {
      throw forbidden('Access denied: You can only delete your own files');
    }

    await deps.storage.deleteObject(deps.buckets.fileBucket, fileName);
    return { status: 204 };
  });
}

import { Router } from 'express';
import type { FilesDeps } from './deps.js';
import { createDeleteFileHandler } from './deleteFile.js';
import { createGetDownloadUrlHandler } from './getFileDownloadSignedUrl.js';
import { createUploadUrlHandler } from './getFileUploadSignedUrl.js';

/**
 * files リソース群 Router。/api 配下（requireAuth 内側）にマウント。MIT 移植。
 * ストレージは FileStorage seam（実 SeaweedFS は後続）。所有権は auth.userId プレフィックス一致。
 * POST/GET /file/url は同一パス別メソッド（アップロード/ダウンロード署名）。削除はキーをパスで受ける。
 */
export function createFilesRouter(deps: FilesDeps): Router {
  const router = Router();
  router.post('/file/url', createUploadUrlHandler(deps.storage, deps.buckets.fileBucket));
  router.get('/file/url', createGetDownloadUrlHandler(deps));
  router.delete('/file/:fileName', createDeleteFileHandler(deps));
  return router;
}

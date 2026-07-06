import { Router } from 'express';
import type { ImageDeps } from './deps.js';
import { createGenerateImageHandler } from './generateImage.js';

/**
 * image リソース群 Router。/api 配下（requireAuth 内側）にマウント。MIT 移植。
 * 画像生成バックエンドは ImageClient seam（OSS 代替は選定後に配線）。
 */
export function createImageRouter(deps: ImageDeps): Router {
  const router = Router();
  router.post('/image/generate', createGenerateImageHandler(deps));
  return router;
}

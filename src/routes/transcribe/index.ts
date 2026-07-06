import { Router } from 'express';
import { createUploadUrlHandler } from '../files/getFileUploadSignedUrl.js';
import type { TranscribeDeps } from './deps.js';
import { createGetTranscriptionHandler } from './getTranscription.js';
import { createStartTranscriptionHandler } from './startTranscription.js';

/**
 * transcribe リソース群 Router。/api 配下（requireAuth 内側）にマウント。MIT 移植。
 * POST /transcribe/url は files のアップロード署名ハンドラを audio バケットへ流用する。
 * バックエンド（Whisper 系）は TranscriptionClient seam（後続配線）。
 */
export function createTranscribeRouter(deps: TranscribeDeps): Router {
  const router = Router();
  router.post('/transcribe/start', createStartTranscriptionHandler(deps));
  router.post('/transcribe/url', createUploadUrlHandler(deps.storage, deps.buckets.audioBucket));
  router.get('/transcribe/result/:jobName', createGetTranscriptionHandler(deps));
  return router;
}

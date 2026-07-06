import type { FileStorage } from '../../lib/storage/fileStorage.js';
import type { StorageBuckets } from '../../lib/storage/config.js';
import type { TranscriptionClient } from '../../lib/transcription/transcriptionClient.js';

/**
 * transcribe Router の依存（注入式）。transcription は文字起こし seam、storage/buckets は /transcribe/url
 * （アップロード署名 URL を audio バケットへ流用）に使う。
 */
export interface TranscribeDeps {
  transcription: TranscriptionClient;
  storage: FileStorage;
  buckets: StorageBuckets;
}

import type { TranscriptionAdapter } from './adapters/base.js';
import { createFasterWhisperAdapter } from './adapters/fasterWhisperAdapter.js';
import { type TranscriptionConfig, loadTranscriptionConfig } from './config.js';

/**
 * TRANSCRIPTION_BACKEND に応じたアダプタを返す（createLlmAdapter／createImageAdapter と対称）。
 * 現状は faster-whisper-server のみ（loadTranscriptionConfig が他経路を弾く）。
 */
export function createTranscriptionAdapter(
  config: TranscriptionConfig = loadTranscriptionConfig(),
): TranscriptionAdapter {
  return createFasterWhisperAdapter({
    baseURL: config.baseURL,
    model: config.model,
    language: config.language,
    timeoutMs: config.timeoutMs,
  });
}

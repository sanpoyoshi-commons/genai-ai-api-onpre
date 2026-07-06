import type { ImageAdapter } from './adapters/base.js';
import { createSdcppAdapter } from './adapters/sdcppAdapter.js';
import { type ImageConfig, loadImageConfig } from './config.js';

/**
 * IMAGE_BACKEND に応じたアダプタを返す（createLlmAdapter と対称）。
 * 現状は stable-diffusion.cpp server のみ（loadImageConfig が他経路を弾く）。
 */
export function createImageAdapter(config: ImageConfig = loadImageConfig()): ImageAdapter {
  return createSdcppAdapter({
    baseURL: config.baseURL,
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  });
}

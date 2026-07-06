/**
 * 画像生成モジュール（LLM 抽象化と対称、stable-diffusion.cpp 実配線）。
 * seam（ImageClient）の背後に置く経路非依存レイヤー：config → factory → adapter、paramMapper は標準化パラメータへの写像。
 */
export type { ImageAdapter } from './adapters/base.js';
export { type ImageConfig, loadImageConfig } from './config.js';
export { ImageError, type ImageErrorCode, isImageError } from './errors.js';
export { createImageAdapter } from './factory.js';
export { mapToImageGenRequest } from './paramMapper.js';
export type { ImageGenRequest, SourceImageParams } from './types.js';

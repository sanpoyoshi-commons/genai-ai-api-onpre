/**
 * 文字起こしモジュール（LLM／Image 抽象化と対称、faster-whisper-server 実配線）。
 * seam（TranscriptionClient）の背後に置く経路非依存レイヤー：config → factory → adapter、normalize は標準化パラメータへの写像。
 * 本体（Whisper 呼び出し）は worker（pollTranscriptionStatus）が使い、api 側は状態ストアの起票・読み出しのみ。
 */
export type { TranscriptionAdapter } from './adapters/base.js';
export { type TranscriptionConfig, loadTranscriptionConfig } from './config.js';
export { TranscriptionError, type TranscriptionErrorCode, isTranscriptionError } from './errors.js';
export { createTranscriptionAdapter } from './factory.js';
export { mapLanguageCode, normalizeTranscription, removeJapaneseSpaces } from './normalize.js';
export type { TranscribeRequest, TranscribeResult, TranscribeSegment } from './types.js';

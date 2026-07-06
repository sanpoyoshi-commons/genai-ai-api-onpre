import type { TranscribeRequest, TranscribeResult } from '../types.js';

/**
 * 文字起こしアダプタの抽象 IF（LLMAdapter／ImageAdapter と対称）。
 *
 * factory が TRANSCRIPTION_BACKEND に応じた実装を返す。正規化リクエスト（TranscribeRequest）を受け取り、経路 API へ
 * 写して検出言語＋セグメントを返す。Transcript[] への写像（話者マージ・日本語スペース除去）は normalize の責務。
 */
export interface TranscriptionAdapter {
  readonly backend: string;
  /** 音声を文字起こしし、検出言語＋セグメントを返す。 */
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
}

/**
 * 文字起こしの経路非依存レイヤーの型（LLM／Image と対称）。
 *
 * seam（TranscriptionClient）の背後で worker が使う。正規化リクエスト（TranscribeRequest）を adapter が
 * バックエンド API（faster-whisper の OpenAI 互換 /v1/audio/transcriptions）へ写し、検出言語＋セグメントを
 * 返す（TranscribeResult）。話者マージ・日本語スペース除去は normalize の責務（経路非依存）。
 */

/** 文字起こし要求（音声バイト列＋モデル指定）。話者分離は非対応。 */
export interface TranscribeRequest {
  /** 音声バイト列（worker が storage から取得して渡す）。 */
  audio: Uint8Array;
  /** multipart 送信時のファイル名（拡張子で Whisper 側が形式判定）。 */
  filename: string;
  /** 使用モデル（空なら config 既定）。 */
  model?: string;
  /** 言語ヒント（未指定は自動検出）。 */
  language?: string;
}

/** 文字起こしの 1 セグメント（時刻は将来の話者マージ用に保持）。 */
export interface TranscribeSegment {
  text: string;
  start?: number;
  end?: number;
}

/** 文字起こし結果（検出言語＋セグメント＋全文）。normalize が Transcript[] へ写像する。 */
export interface TranscribeResult {
  /** 検出言語（ISO-639-1、例 'ja'）。normalize が AWS Transcribe 風コードへ写像する。 */
  language: string;
  segments: TranscribeSegment[];
  /** バックエンドが返す全文（segments 結合の冗長コピー。空でも segments から再構成可）。 */
  text: string;
}

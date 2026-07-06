import type { Transcript } from '../types/genaiWeb.js';
import type { TranscribeResult } from './types.js';

/**
 * 文字起こし結果の正規化（話者マージ・日本語スペース除去の写像、経路非依存）。
 *
 * 話者分離非対応＝全セグメントを単一話者に畳み、speakerLabel は付けない。
 * 日本語は Whisper がセグメント境界に半角スペースを挿入するため、日本語文字に隣接するスペースを除去する
 * （英数字間の意味あるスペースは保持）。languageCode は Whisper の ISO-639-1（'ja'）を AWS Transcribe 風
 * （'ja-JP'）へ写像する（フロント契約は e2e で確証）。
 */

/**
 * Whisper 言語表記 → AWS Transcribe 風（BCP-47）。未知は素通し。
 * speaches が ISO-639-1（'ja'）か全名（'japanese'）のどちらを返すか未確証のため両方を受ける（e2e で確証）。
 */
const LANGUAGE_CODE_MAP: Record<string, string> = {
  ja: 'ja-JP',
  japanese: 'ja-JP',
  en: 'en-US',
  english: 'en-US',
  zh: 'zh-CN',
  chinese: 'zh-CN',
  ko: 'ko-KR',
  korean: 'ko-KR',
};

export function mapLanguageCode(whisperLanguage: string): string {
  const key = whisperLanguage.trim().toLowerCase();
  return LANGUAGE_CODE_MAP[key] ?? whisperLanguage;
}

function isJapanese(language: string): boolean {
  const key = language.trim().toLowerCase();
  return key === 'ja' || key === 'japanese';
}

// 日本語（漢字・ひらがな・カタカナ・全角記号・句読点）の文字クラス。
const JP_CHAR = '[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\u3000-\\u303F\\uFF00-\\uFFEF]';
const SPACE_AFTER_JP = new RegExp(`(${JP_CHAR})\\s+`, 'gu');
const SPACE_BEFORE_JP = new RegExp(`\\s+(${JP_CHAR})`, 'gu');

/** 日本語文字に隣接する半角／全角スペースを除去する（英数字間のスペースは保持）。 */
export function removeJapaneseSpaces(text: string): string {
  return text.replace(SPACE_AFTER_JP, '$1').replace(SPACE_BEFORE_JP, '$1');
}

/**
 * TranscribeResult を seam の Transcript[] へ写す。単一話者：全セグメントを結合し 1 件にまとめる。
 * 日本語（languageCode が ja 系）はスペース除去を適用する。
 */
export function normalizeTranscription(result: TranscribeResult): {
  languageCode: string;
  transcripts: Transcript[];
} {
  const joined = result.segments
    .map((s) => s.text)
    .join('')
    .trim();
  const text = isJapanese(result.language) ? removeJapaneseSpaces(joined) : joined.replace(/\s+/g, ' ');
  return {
    languageCode: mapLanguageCode(result.language),
    transcripts: [{ transcript: text }],
  };
}

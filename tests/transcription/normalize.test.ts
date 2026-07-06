import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mapLanguageCode,
  normalizeTranscription,
  removeJapaneseSpaces,
} from '../../src/transcription/normalize.js';

test('removeJapaneseSpaces: 日本語文字に隣接するスペースを除去（英数字間は保持）', () => {
  assert.equal(removeJapaneseSpaces('今日 は 晴れ です'), '今日は晴れです');
  assert.equal(removeJapaneseSpaces('値 は 10 です'), '値は10です');
  assert.equal(removeJapaneseSpaces('ABC は DEF'), 'ABCはDEF');
  // 英数字のみの並びは保持。
  assert.equal(removeJapaneseSpaces('Hello World'), 'Hello World');
});

test('mapLanguageCode: ISO-639-1 / 全名どちらも AWS Transcribe 風へ写像・未知は素通し', () => {
  assert.equal(mapLanguageCode('ja'), 'ja-JP');
  assert.equal(mapLanguageCode('japanese'), 'ja-JP');
  assert.equal(mapLanguageCode('en'), 'en-US');
  assert.equal(mapLanguageCode('fr'), 'fr'); // 未知は素通し
});

test('normalizeTranscription(ja): 全セグメント結合・スペース除去・単一話者（speakerLabel 無し）', () => {
  const out = normalizeTranscription({
    language: 'ja',
    text: '',
    segments: [{ text: '今日 は ' }, { text: '晴れ です' }],
  });
  assert.equal(out.languageCode, 'ja-JP');
  assert.deepEqual(out.transcripts, [{ transcript: '今日は晴れです' }]);
});

test('normalizeTranscription(en): スペース整形のみ・単一話者', () => {
  const out = normalizeTranscription({
    language: 'english',
    text: '',
    segments: [{ text: 'Hello ' }, { text: ' world' }],
  });
  assert.equal(out.languageCode, 'en-US');
  assert.deepEqual(out.transcripts, [{ transcript: 'Hello world' }]);
});

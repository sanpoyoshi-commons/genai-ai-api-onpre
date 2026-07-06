import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFasterWhisperAdapter } from '../../src/transcription/adapters/fasterWhisperAdapter.js';
import { TranscriptionError } from '../../src/transcription/errors.js';

// 注入用モック fetch（openai SDK が組み立てる /audio/transcriptions multipart リクエストへ応答する）。
function makeFetch(handler: () => Response | Promise<Response>): typeof fetch {
  return (async () => handler()) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const adapterWith = (handler: () => Response | Promise<Response>, model = 'Systran/faster-whisper-large-v3') =>
  createFasterWhisperAdapter({
    baseURL: 'http://whisper:8000/v1',
    model,
    timeoutMs: 30_000,
    fetch: makeFetch(handler),
  });

const verbose = {
  task: 'transcribe',
  language: 'ja',
  duration: 1.2,
  text: '今日は晴れです',
  segments: [
    { id: 0, seek: 0, start: 0, end: 1.2, text: '今日 は 晴れ です', tokens: [], temperature: 0, avg_logprob: 0, compression_ratio: 0, no_speech_prob: 0 },
  ],
};

test('transcribe: verbose_json を検出言語＋セグメントへ写像', async () => {
  const adapter = adapterWith(() => jsonResponse(verbose));
  const out = await adapter.transcribe({ audio: new Uint8Array([1, 2, 3]), filename: 'a.mp3' });
  assert.equal(out.language, 'ja');
  assert.equal(out.text, '今日は晴れです');
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0]?.text, '今日 は 晴れ です');
});

test('transcribe: segments 欠落時は text 1 本へ畳む', async () => {
  const adapter = adapterWith(() => jsonResponse({ language: 'ja', text: '全文', segments: [] }));
  const out = await adapter.transcribe({ audio: new Uint8Array([1]), filename: 'a.wav' });
  assert.deepEqual(out.segments, [{ text: '全文' }]);
});

test('transcribe: 400 は INVALID_AUDIO（恒久・retryable=false）', async () => {
  const adapter = adapterWith(() => new Response('bad', { status: 400 }));
  await assert.rejects(
    () => adapter.transcribe({ audio: new Uint8Array([1]), filename: 'a.mp3' }),
    (err: unknown) => {
      assert.ok(err instanceof TranscriptionError);
      assert.equal(err.code, 'INVALID_AUDIO');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('transcribe: 503 は TRANSCRIPTION_FAILED（一過性・retryable=true）', async () => {
  const adapter = adapterWith(() => new Response('overloaded', { status: 503 }));
  await assert.rejects(
    () => adapter.transcribe({ audio: new Uint8Array([1]), filename: 'a.mp3' }),
    (err: unknown) => {
      assert.ok(err instanceof TranscriptionError);
      assert.equal(err.code, 'TRANSCRIPTION_FAILED');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('transcribe: 接続失敗は NETWORK（一過性・retryable=true）', async () => {
  const adapter = adapterWith(() => {
    throw new Error('connect ECONNREFUSED');
  });
  await assert.rejects(
    () => adapter.transcribe({ audio: new Uint8Array([1]), filename: 'a.mp3' }),
    (err: unknown) => {
      assert.ok(err instanceof TranscriptionError);
      assert.equal(err.code, 'NETWORK');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, toFile } from 'openai';
import { TranscriptionError, type TranscriptionErrorCode } from '../errors.js';
import type { TranscribeRequest, TranscribeResult, TranscribeSegment } from '../types.js';
import type { TranscriptionAdapter } from './base.js';

/**
 * faster-whisper-server（speaches）アダプタ。
 *
 * speaches は OpenAI 互換の POST /v1/audio/transcriptions を持つため、導入済みの openai 公式 SDK を baseURL
 * 差し替えで再利用する（LLM の openaiCompatAdapter と同方式）。verbose_json で検出言語＋セグメントを得る。speaches は
 * 認証なしのためダミー apiKey を渡す。fetch を注入可能にして unit はモック注入。リトライは無効（再配信は worker 側）。
 * 経路固有例外は toTranscriptionError で TranscriptionError に正規化し、retryable で worker の再配信可否を伝える。
 */
export interface FasterWhisperConfig {
  baseURL: string;
  model: string;
  language?: string;
  timeoutMs: number;
  /** 注入用 fetch（unit はモック注入）。未指定はグローバル fetch。 */
  fetch?: typeof fetch;
}

const BACKEND = 'faster-whisper';

export function createFasterWhisperAdapter(config: FasterWhisperConfig): TranscriptionAdapter {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: 'speaches-no-auth', // speaches は認証なし。SDK が apiKey 必須のためダミー。
    timeout: config.timeoutMs,
    maxRetries: 0,
    fetch: config.fetch,
  });

  return {
    backend: BACKEND,
    async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
      try {
        const file = await toFile(request.audio, request.filename);
        const res = await client.audio.transcriptions.create({
          file,
          model: request.model || config.model,
          response_format: 'verbose_json',
          ...(request.language || config.language
            ? { language: request.language || config.language }
            : {}),
        });
        return mapVerbose(res);
      } catch (err) {
        throw toTranscriptionError(err);
      }
    },
  };
}

/** verbose_json 応答（language / text / segments）を正規化結果へ写す。segments 欠落時は text 1 本へ畳む。 */
function mapVerbose(res: OpenAI.Audio.TranscriptionVerbose): TranscribeResult {
  const segments: TranscribeSegment[] = (res.segments ?? []).map((s) => ({
    text: s.text,
    start: s.start,
    end: s.end,
  }));
  return {
    language: res.language ?? '',
    text: res.text ?? '',
    segments: segments.length > 0 ? segments : [{ text: res.text ?? '' }],
  };
}

/** 経路固有例外を TranscriptionError へ正規化（LLM の toLLMError と対称）。 */
function toTranscriptionError(err: unknown): TranscriptionError {
  if (err instanceof TranscriptionError) {
    return err;
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new TranscriptionError({ code: 'TIMEOUT', backend: BACKEND, message: err.message, retryable: true, cause: err });
  }
  if (err instanceof APIConnectionError) {
    return new TranscriptionError({ code: 'NETWORK', backend: BACKEND, message: err.message, retryable: true, cause: err });
  }
  if (err instanceof APIError) {
    const { code, retryable } = mapStatus(err.status);
    return new TranscriptionError({ code, backend: BACKEND, message: err.message, retryable, cause: err });
  }
  return new TranscriptionError({
    code: 'INTERNAL',
    backend: BACKEND,
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
    cause: err,
  });
}

function mapStatus(status: number | undefined): { code: TranscriptionErrorCode; retryable: boolean } {
  switch (status) {
    case 400:
    case 415:
    case 422:
      return { code: 'INVALID_AUDIO', retryable: false };
    case 404:
      return { code: 'MODEL_NOT_FOUND', retryable: false };
    case 429:
      return { code: 'RATE_LIMIT', retryable: true };
    default:
      return { code: 'TRANSCRIPTION_FAILED', retryable: status !== undefined && status >= 500 };
  }
}

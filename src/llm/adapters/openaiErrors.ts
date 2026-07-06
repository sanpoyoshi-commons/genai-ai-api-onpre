import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { LLMError, type LLMErrorCode } from '../errors.js';

/**
 * openai SDK（OpenAI 互換経路）固有例外 → LLMError 正規化。
 *
 * chat（openaiCompatAdapter）と embedding（openaiCompatEmbeddingAdapter）が共有する。OpenAI 互換経路は
 * chat/embeddings いずれも同じ SDK 例外クラス（APIConnectionTimeoutError/APIConnectionError/APIError）を
 * 投げるため、写像規約も共通化して二重定義を避ける。
 */
export function toLLMError(err: unknown, backend: string, requestId?: string): LLMError {
  if (err instanceof LLMError) {
    return err;
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new LLMError({ code: 'TIMEOUT', backend, message: err.message, retryable: true, cause: err, requestId });
  }
  if (err instanceof APIConnectionError) {
    return new LLMError({ code: 'NETWORK', backend, message: err.message, retryable: true, cause: err, requestId });
  }
  if (err instanceof APIError) {
    const { code, retryable } = mapStatus(err.status);
    return new LLMError({ code, backend, message: err.message, retryable, cause: err, requestId });
  }
  return new LLMError({
    code: 'INTERNAL',
    backend,
    message: err instanceof Error ? err.message : String(err),
    cause: err,
    requestId,
  });
}

export function mapStatus(status: number | undefined): { code: LLMErrorCode; retryable: boolean } {
  switch (status) {
    case 401:
    case 403:
      return { code: 'AUTHENTICATION', retryable: false };
    case 429:
      return { code: 'RATE_LIMIT', retryable: true };
    case 400:
      return { code: 'INVALID_REQUEST', retryable: false };
    case 404:
      return { code: 'MODEL_NOT_FOUND', retryable: false };
    default:
      return { code: 'INTERNAL', retryable: status !== undefined && status >= 500 };
  }
}

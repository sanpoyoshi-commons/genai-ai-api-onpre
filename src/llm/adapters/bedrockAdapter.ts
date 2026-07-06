import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  ContentBlock,
  ConverseCommandOutput,
  ConverseStreamCommandOutput,
  Message as BedrockMessage,
  SystemContentBlock,
  TokenUsage,
} from '@aws-sdk/client-bedrock-runtime';
import { LLMError, type LLMErrorCode } from '../errors.js';
import type { ChatChunk, ChatInput, ChatOutput, Message, StopReason, Usage } from '../types.js';
import type { LLMAdapter } from './base.js';

/**
 * Amazon Bedrock アダプタ（Converse API）。
 *
 * Bedrock は SigV4 認証＝OpenAI 互換不可のため openaiCompatAdapter を流用できず専用アダプタとする。Converse API
 * （ConverseCommand / ConverseStreamCommand）はモデル横断の統一メッセージ形式で、抽象化レイヤーの chat/chatStream に素直に
 * 写せる（InvokeModel のモデル固有ボディ分岐を避ける）。認証は AWS SDK の既定クレデンシャルチェーン
 * （env の AWS_ACCESS_KEY_ID/SECRET[/SESSION_TOKEN]・IAM ロール・プロファイル）に委ね、region は config 必須。
 * timeout は AbortSignal.timeout で付与（SDK の maxAttempts は既定のまま＝リトライ判断は呼び出し側）。
 * client は注入可能（unit はモック注入＝openaiCompatAdapter の fetch 注入と同思想）。
 */
export interface BedrockAdapterConfig {
  backend: string;
  /** AWS リージョン（SDK のエンドポイント解決に必須）。 */
  region: string;
  defaultModel?: string;
  /** 既定 max_tokens（Converse inferenceConfig.maxTokens。未指定リクエストに補う）。 */
  defaultMaxTokens?: number;
  timeoutMs: number;
  /** 注入用クライアント（unit はモック）。未指定は region から実クライアントを生成。 */
  client?: BedrockRuntimeClient;
}

export function createBedrockAdapter(config: BedrockAdapterConfig): LLMAdapter {
  const { backend } = config;
  const client = config.client ?? new BedrockRuntimeClient({ region: config.region });

  return {
    backend,
    async chat(input: ChatInput): Promise<ChatOutput> {
      try {
        const res = await client.send(new ConverseCommand(toConverseInput(input, config)), {
          abortSignal: AbortSignal.timeout(input.timeoutMs ?? config.timeoutMs),
        });
        return mapConverseOutput(res);
      } catch (err) {
        throw toLLMError(err, backend, input.requestId);
      }
    },
    async *chatStream(input: ChatInput): AsyncIterable<ChatChunk> {
      let stream: ConverseStreamCommandOutput['stream'];
      try {
        const res = await client.send(new ConverseStreamCommand(toConverseInput(input, config)), {
          abortSignal: AbortSignal.timeout(input.timeoutMs ?? config.timeoutMs),
        });
        stream = res.stream;
      } catch (err) {
        throw toLLMError(err, backend, input.requestId);
      }
      if (!stream) {
        return;
      }
      try {
        for await (const event of stream) {
          const delta = event.contentBlockDelta?.delta?.text;
          if (delta) {
            yield { type: 'text_delta', text: delta };
          }
          if (event.messageStop) {
            yield { type: 'message_stop', stopReason: mapStopReason(event.messageStop.stopReason) };
          }
          if (event.metadata?.usage) {
            yield { type: 'usage', usage: mapUsage(event.metadata.usage) };
          }
        }
      } catch (err) {
        throw toLLMError(err, backend, input.requestId);
      }
    },
  };
}

/** ChatInput → ConverseCommand/ConverseStreamCommand の共通入力。 */
function toConverseInput(input: ChatInput, config: BedrockAdapterConfig) {
  const { system, messages } = toBedrockMessages(input);
  const maxTokens = input.maxTokens ?? config.defaultMaxTokens;
  return {
    modelId: resolveModel(input, config),
    messages,
    ...(system.length > 0 ? { system } : {}),
    inferenceConfig: {
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.stopSequences !== undefined ? { stopSequences: input.stopSequences } : {}),
    },
  };
}

/** ChatInput.model が空なら config の既定モデルへ委譲。双方空はモデル未指定エラー。 */
function resolveModel(input: ChatInput, config: BedrockAdapterConfig): string {
  const model = input.model || config.defaultModel;
  if (!model) {
    throw new LLMError({
      code: 'INVALID_REQUEST',
      backend: config.backend,
      message: 'モデルが指定されていません（BEDROCK_DEFAULT_CHAT_MODEL 等の既定モデルを設定してください）',
      requestId: input.requestId,
    });
  }
  return model;
}

/**
 * Message[] → Bedrock Converse 形式（text 中心）。
 * Bedrock は system を messages と分離する（専用 system パラメータ）。role は user/assistant のみ許容のため、
 * 'system' は system へ振り分け、想定外の 'tool' は現状では発生しない（防御的に user 扱い）。
 */
function toBedrockMessages(input: ChatInput): {
  system: SystemContentBlock[];
  messages: BedrockMessage[];
} {
  const system: SystemContentBlock[] = [];
  if (input.system) {
    system.push({ text: input.system });
  }
  const messages: BedrockMessage[] = [];
  for (const m of input.messages) {
    if (m.role === 'system') {
      system.push({ text: contentToText(m.content) });
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: [{ text: contentToText(m.content) } as ContentBlock] });
  }
  return { system, messages };
}

function contentToText(content: string | Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function mapConverseOutput(res: ConverseCommandOutput): ChatOutput {
  const blocks = res.output?.message?.content ?? [];
  const text = blocks
    .map((b) => b.text ?? '')
    .join('');
  return {
    message: { role: 'assistant', content: text },
    stopReason: mapStopReason(res.stopReason),
    usage: mapUsage(res.usage),
  };
}

function mapUsage(u: TokenUsage | undefined): Usage {
  return {
    promptTokens: u?.inputTokens ?? 0,
    completionTokens: u?.outputTokens ?? 0,
    totalTokens: u?.totalTokens ?? 0,
    estimatedCostUsd: 0, // cloud の pricing 算出は後続。
  };
}

/** Bedrock stopReason → StopReason。 */
function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'content_filter';
    default:
      return 'end_turn';
  }
}

/** Bedrock サービス例外を LLMError へ正規化。例外名・HTTP ステータスで分類。 */
function toLLMError(err: unknown, backend: string, requestId?: string): LLMError {
  if (err instanceof LLMError) {
    return err;
  }
  const name = err instanceof Error ? err.name : '';
  // AbortSignal.timeout 発火は TimeoutError（環境により AbortError）。
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new LLMError({ code: 'TIMEOUT', backend, message: '推論がタイムアウトしました', retryable: true, cause: err, requestId });
  }
  const byName = mapExceptionName(name);
  if (byName) {
    return new LLMError({ code: byName.code, backend, message: errMessage(err), retryable: byName.retryable, cause: err, requestId });
  }
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const byStatus = mapStatus(status);
  return new LLMError({ code: byStatus.code, backend, message: errMessage(err), retryable: byStatus.retryable, cause: err, requestId });
}

function mapExceptionName(name: string): { code: LLMErrorCode; retryable: boolean } | undefined {
  switch (name) {
    case 'AccessDeniedException':
      return { code: 'AUTHENTICATION', retryable: false };
    case 'ThrottlingException':
      return { code: 'RATE_LIMIT', retryable: true };
    case 'ServiceQuotaExceededException':
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    case 'ValidationException':
      return { code: 'INVALID_REQUEST', retryable: false };
    case 'ResourceNotFoundException':
      return { code: 'MODEL_NOT_FOUND', retryable: false };
    case 'ModelTimeoutException':
      return { code: 'TIMEOUT', retryable: true };
    case 'ModelNotReadyException':
    case 'ServiceUnavailableException':
    case 'InternalServerException':
      return { code: 'INTERNAL', retryable: true };
    case 'ModelErrorException':
      return { code: 'INTERNAL', retryable: false };
    default:
      return undefined;
  }
}

function mapStatus(status: number | undefined): { code: LLMErrorCode; retryable: boolean } {
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

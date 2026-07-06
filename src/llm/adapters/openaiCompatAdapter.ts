import OpenAI from 'openai';
import { LLMError } from '../errors.js';
import type { ChatChunk, ChatInput, ChatOutput, Message, StopReason, Usage } from '../types.js';
import type { LLMAdapter } from './base.js';
import { toLLMError } from './openaiErrors.js';

/**
 * OpenAI 互換アダプタ（ollama/vllm/openai 共通、text 中心の最小構成）。
 *
 * openai 公式 SDK を baseURL 差し替えで共通利用する（4 経路を 1 アダプタで吸収）。現状は
 * テキスト生成（chat/chatStream）のみ。fetch を注入可能にして unit はモック注入（KeycloakIdpClient と同方式）。
 * リトライは無効（maxRetries: 0＝リトライ判断は呼び出し側、LLMError.retryable が材料）。経路固有例外は
 * toLLMError で LLMError に正規化する。
 */
export interface OpenAICompatConfig {
  backend: string;
  baseURL: string;
  apiKey: string;
  defaultModel?: string;
  /** 既定 max_tokens。リクエスト未指定時に補う（anthropic 互換は max_tokens 必須＝400 回避）。 */
  defaultMaxTokens?: number;
  timeoutMs: number;
  /** 注入用 fetch（unit はモック注入）。未指定はグローバル fetch。 */
  fetch?: typeof fetch;
}

export function createOpenAICompatAdapter(config: OpenAICompatConfig): LLMAdapter {
  const { backend } = config;
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0,
    fetch: config.fetch,
  });

  return {
    backend,
    async chat(input: ChatInput): Promise<ChatOutput> {
      try {
        const res = await client.chat.completions.create({
          model: resolveModel(input, config),
          messages: toOpenAIMessages(input),
          max_tokens: input.maxTokens ?? config.defaultMaxTokens,
          temperature: input.temperature,
          top_p: input.topP,
          stop: input.stopSequences,
          stream: false,
        });
        return mapChatCompletion(res);
      } catch (err) {
        throw toLLMError(err, backend, input.requestId);
      }
    },
    async *chatStream(input: ChatInput): AsyncIterable<ChatChunk> {
      let stream: Awaited<ReturnType<typeof openStream>>;
      try {
        stream = await openStream(client, input, config);
      } catch (err) {
        throw toLLMError(err, backend, input.requestId);
      }
      try {
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const delta = choice?.delta?.content;
          if (delta) {
            yield { type: 'text_delta', text: delta };
          }
          if (choice?.finish_reason) {
            yield { type: 'message_stop', stopReason: mapFinishReason(choice.finish_reason) };
          }
          if (chunk.usage) {
            yield { type: 'usage', usage: mapUsage(chunk.usage) };
          }
        }
      } catch (err) {
        throw toLLMError(err, backend, input.requestId);
      }
    },
  };
}

function openStream(client: OpenAI, input: ChatInput, config: OpenAICompatConfig) {
  return client.chat.completions.create({
    model: resolveModel(input, config),
    messages: toOpenAIMessages(input),
    max_tokens: input.maxTokens ?? config.defaultMaxTokens,
    temperature: input.temperature,
    top_p: input.topP,
    stop: input.stopSequences,
    stream: true,
    stream_options: { include_usage: true }, // 最終チャンクに usage を同梱
  });
}

/** ChatInput.model が空なら config の既定モデルへ委譲。双方空はモデル未指定エラー。 */
function resolveModel(input: ChatInput, config: OpenAICompatConfig): string {
  const model = input.model || config.defaultModel;
  if (!model) {
    throw new LLMError({
      code: 'INVALID_REQUEST',
      backend: config.backend,
      message: 'モデルが指定されていません（OLLAMA_DEFAULT_CHAT_MODEL 等の既定モデルを設定してください）',
      requestId: input.requestId,
    });
  }
  return model;
}

/** Message[] → OpenAI Chat Completions messages（text 中心。system は先頭に前置）。 */
function toOpenAIMessages(input: ChatInput): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (input.system) {
    messages.push({ role: 'system', content: input.system });
  }
  for (const m of input.messages) {
    // 現状は text のみ。role 'tool' は発生しない（型整合のためのキャスト）。
    messages.push({ role: m.role, content: contentToText(m.content) } as OpenAI.ChatCompletionMessageParam);
  }
  return messages;
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

function mapChatCompletion(res: OpenAI.ChatCompletion): ChatOutput {
  const choice = res.choices[0];
  return {
    message: { role: 'assistant', content: choice?.message?.content ?? '' },
    stopReason: mapFinishReason(choice?.finish_reason),
    usage: mapUsage(res.usage),
  };
}

function mapUsage(u: OpenAI.CompletionUsage | undefined): Usage {
  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
    estimatedCostUsd: 0, // ローカル経路は常に 0
  };
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

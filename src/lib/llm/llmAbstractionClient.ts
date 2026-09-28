import type { LLMAdapter } from '../../llm/adapters/base.js';
import { createLlmAdapter } from '../../llm/factory.js';
import type { ContentBlock, Message } from '../../llm/types.js';
import { getRequestLogger } from '../../middleware/requestContext.js';
import type { UnrecordedMessage } from '../../types/genaiWeb.js';
import { hasAttachments, renderAttachmentsForMessages } from '../attachments/index.js';
import { createByteFallbackDecoder, decodeByteFallback } from './byteFallback.js';
import type { LlmClient, LlmGenerateInput } from './llmClient.js';

/**
 * LlmClient seam の実装＝LLM 抽象化レイヤーへの委譲ブリッジ。
 *
 * skeleton 実装を置き換える。seam（generate/generateStream）を維持し背後に抽象化レイヤーの
 * LLMAdapter（chat/chatStream）を置くため predict 群は無改修。上流 UnrecordedMessage は
 * 抽象化レイヤーの Message へ text 中心で写像（multimodal は現状スコープ外）。三段境界は
 * chatStream(ChatChunk.text_delta) → 本 generateStream(string yield) → predictStream の streamingChunkLine(JSONL)。
 * アダプタは lazy 生成（未配線でも app 起動可・初回使用時に config 解決＝KeycloakIdpClient と同方式）。
 * adapterFactory は注入可能（unit は fake adapter 注入）。
 */
/**
 * 既定サンプリング温度を env から解決する。LLM_DEFAULT_TEMPERATURE が未設定/不正なら undefined
 * （＝バックエンド既定。ollama OpenAI 互換は 1.0）。0〜2 の範囲のみ採用する。
 * ダイアグラム等の構造化出力では 0.2 程度に下げると mermaid 書式の遵守が安定する。
 */
function readDefaultTemperature(): number | undefined {
  const raw = process.env.LLM_DEFAULT_TEMPERATURE?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    return undefined;
  }
  return value;
}

export class LlmAbstractionClient implements LlmClient {
  private adapter?: LLMAdapter;

  constructor(
    private readonly adapterFactory: () => LLMAdapter = () => createLlmAdapter(),
    private readonly defaultTemperature: number | undefined = readDefaultTemperature(),
  ) {}

  private get(): LLMAdapter {
    if (!this.adapter) {
      this.adapter = this.adapterFactory();
    }
    return this.adapter;
  }

  async generate(input: LlmGenerateInput): Promise<string> {
    const adapter = this.get();
    const log = getRequestLogger().child({
      component: `api.llm.${adapter.backend}`,
      model: input.model,
    });
    const startedAt = Date.now();
    log.debug({ event: 'llm_call_started' }, 'llm call started');
    try {
      const output = await adapter.chat({
        model: input.model,
        messages: await toMessages(input.messages, adapter.supportsImages === true),
        requestId: input.requestId,
        temperature: input.temperature ?? this.defaultTemperature,
      });
      log.info(
        { event: 'llm_call_succeeded', latency_ms: Date.now() - startedAt },
        'llm call succeeded',
      );
      // バイトフォールバック表記（`<0xE3><0x80><0x80>` 等）が混ざる語彙があるためここで復号する。
      return decodeByteFallback(contentToString(output.message.content));
    } catch (err) {
      log.error(
        {
          event: 'llm_call_failed',
          latency_ms: Date.now() - startedAt,
          error: { message: err instanceof Error ? err.message : String(err) },
        },
        'llm call failed',
      );
      throw err;
    }
  }

  async *generateStream(input: LlmGenerateInput): AsyncIterable<string> {
    const adapter = this.get();
    const log = getRequestLogger().child({
      component: `api.llm.${adapter.backend}`,
      model: input.model,
    });
    const startedAt = Date.now();
    log.debug({ event: 'llm_call_started', streaming: true }, 'llm stream started');
    try {
      const stream = adapter.chatStream({
        model: input.model,
        messages: await toMessages(input.messages, adapter.supportsImages === true),
        requestId: input.requestId,
        temperature: input.temperature ?? this.defaultTemperature,
      });
      // チャンク境界でバイトトークン列が分断されても復号できるよう逐次復号器を挟む。
      const bytes = createByteFallbackDecoder();
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          const text = bytes.push(chunk.text);
          if (text) {
            yield text;
          }
        } else if (chunk.type === 'error') {
          // アダプタが error チャンクで返す経路（throw 経路は下の catch が握る）。
          throw chunk.error;
        }
      }
      const tail = bytes.flush();
      if (tail) {
        yield tail;
      }
      log.info(
        { event: 'llm_call_succeeded', streaming: true, latency_ms: Date.now() - startedAt },
        'llm stream succeeded',
      );
    } catch (err) {
      log.error(
        {
          event: 'llm_call_failed',
          streaming: true,
          latency_ms: Date.now() - startedAt,
          error: { message: err instanceof Error ? err.message : String(err) },
        },
        'llm stream failed',
      );
      throw err;
    }
  }
}

/**
 * 上流 UnrecordedMessage[] → 抽象化レイヤーの Message[]（text 中心。llmType/trace は渡さない）。
 *
 * 添付（extraData）がある場合だけ、取り出した中身を `<documents>` ブロックにして本文の前に置く
 * （src/lib/attachments）。**添付が無い呼び出し（predictTitle / RAG / Code Interpreter / 法令 RAG / 判定）は
 * 従来と1バイトも変わらない**——下の早期 return がその保証で、回帰テストで固定している。
 * 文字数の合計の上限は**リクエスト全体**で数えるため、メッセージを1つずつではなくまとめて渡す。
 * 画像は経路が対応を表明しているとき（`LLMAdapter.supportsImages`）だけ image ブロックとして渡し、
 * そうでなければ添付の層が注記へ振り替える（黙って落とさない）。
 * ストリーミングでも最初の yield より前に解決するため、`predictStream` が 200 を書く前に済む。
 */
async function toMessages(messages: UnrecordedMessage[], imagesSupported: boolean): Promise<Message[]> {
  if (!hasAttachments(messages)) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }
  const attachments = await renderAttachmentsForMessages(messages, undefined, { imagesSupported });
  return messages.map((m, i) => {
    const { documents = '', images = [] } = attachments[i] ?? {};
    const text = documents ? `${documents}\n\n${m.content}` : m.content;
    if (images.length === 0) {
      // 画像が無ければ content は文字列のまま（アダプタの写像も従来どおりになる）。
      return { role: m.role, content: text };
    }
    // 資料 → 画像 → 質問 の順に並べる（質問が末尾にある方が追従が安定する）。
    const blocks: ContentBlock[] = [];
    if (documents) {
      blocks.push({ type: 'text', text: documents });
    }
    for (const image of images) {
      blocks.push({ type: 'image', mediaType: image.mediaType, data: image.data });
    }
    blocks.push({ type: 'text', text: m.content });
    return { role: m.role, content: blocks };
  });
}

function contentToString(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

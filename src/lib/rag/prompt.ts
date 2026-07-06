import type { ChunkRecord } from '../../repositories/ragRepository.js';
import type { UnrecordedMessage } from '../../types/genaiWeb.js';

/**
 * retrieve-and-generate の generate 側プロンプト構築（純関数・unit テスト可能）。
 *
 * 上流 RAG（AWS query-expansion-rag / GCP lawsy）は検索チャンクを context に注入して回答を生成し、
 * 回答末尾に参照（出典）を Markdown で連結して返す（reference_generation 相当、LLM 不使用の整形）。
 * 本リポも同形：取得チャンクを番号付き context にし、回答に「参考情報」節を連結する。
 */

const SYSTEM_PROMPT =
  'あなたは提供された参考情報に基づいて日本語で回答するアシスタントです。' +
  '参考情報に根拠がない場合は推測せず「参考情報からは確認できません」と述べてください。' +
  '回答では根拠とした参考情報の番号を [1] のように示してください。';

/** チャンクを番号付き context テキストにする（1 起点・タイトル/見出しを付す）。 */
export function buildContext(chunks: ChunkRecord[]): string {
  return chunks
    .map((c, i) => {
      const head = c.headerPath ? `${c.documentTitle} / ${c.headerPath}` : c.documentTitle;
      return `[${i + 1}] (${head})\n${c.chunkText}`;
    })
    .join('\n\n');
}

/** LLM へ渡すメッセージ列（system + 参考情報付き user）。チャンク無しでも質問だけで生成する。 */
export function buildRagMessages(question: string, chunks: ChunkRecord[]): UnrecordedMessage[] {
  const context = buildContext(chunks);
  const userContent =
    chunks.length > 0
      ? `${question}\n\n以下の参考情報を踏まえて回答してください:\n\n${context}`
      : question;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

/** 回答末尾に連結する「参考情報」節（出典一覧）。チャンク無しなら空文字。 */
export function buildReferenceSection(chunks: ChunkRecord[]): string {
  if (chunks.length === 0) {
    return '';
  }
  const items = chunks
    .map((c, i) => {
      const head = c.headerPath ? `${c.documentTitle} / ${c.headerPath}` : c.documentTitle;
      return `${i + 1}. ${head}`;
    })
    .join('\n');
  return `\n\n---\n### 参考情報\n${items}`;
}

/** 生成回答に参照節を連結して最終 outputs 文字列を作る（上流 outputs と同形）。 */
export function composeAnswer(answer: string, chunks: ChunkRecord[]): string {
  return `${answer}${buildReferenceSection(chunks)}`;
}

export { SYSTEM_PROMPT };

import { modelNotAllowedAsBadRequest, resolveTextModel } from '../../lib/llm/models.js';
import { buildRagMessages } from '../../lib/rag/prompt.js';
import type { ScoredChunk } from '../../lib/rag/ragService.js';
import type { RagDeps } from './deps.js';

/**
 * 検索して回答を作るところ（`/rag/query` と `/rag/ask` で共有する）。
 *
 * 2 本のルートは**返す形だけ**が違う。`/rag/query` は上流 ExApp 契約（`{outputs}`）、`/rag/ask` は画面用に
 * 回答と参照を構造で返す。検索・所有の絞り込み・モデルの照合・プロンプトの組み立ては同じものを通す
 * （片方だけ直して食い違うのを防ぐ）。
 */

export interface GenerateAnswerInput {
  ownerUserId: string;
  question: string;
  /** 回答生成モデル（任意・未指定は既定へ委譲）。 */
  model?: { modelId?: string };
  /** 対象のナレッジ集（任意・未指定なら自分のすべて）。所有の突合はここで行う。 */
  collectionIds?: string[];
  requestId?: string;
}

export interface GenerateAnswerResult {
  /** 生成された回答（参照節は連結しない。呼び出し側が形を決める）。 */
  answer: string;
  /** 回答の根拠にした上位チャンク（1 起点の参照番号はこの並び順）。 */
  chunks: ScoredChunk[];
}

export async function generateAnswer(
  deps: RagDeps,
  input: GenerateAnswerInput,
): Promise<GenerateAnswerResult> {
  let resolvedModel: string;
  try {
    resolvedModel = resolveTextModel(input.model);
  } catch (error) {
    modelNotAllowedAsBadRequest(error);
  }

  const chunks = await deps.rag.search(
    input.ownerUserId,
    input.question,
    { collectionIds: input.collectionIds },
    input.requestId,
  );
  const answer = await deps.llm.generate({
    model: resolvedModel,
    messages: buildRagMessages(input.question, chunks),
    requestId: input.requestId ?? '',
  });

  return { answer, chunks };
}

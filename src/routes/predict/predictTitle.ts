import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { notFound } from '../../lib/http/errors.js';
import { modelNotAllowedAsBadRequest, resolveTextModel } from '../../lib/llm/models.js';
import { parseBody } from '../../lib/http/validation.js';
import type { PredictDeps } from './deps.js';
import { predictTitleSchema } from './schemas.js';

/** "chat#uuid" 形を生 uuid へ（フロントは Chat.chatId をプレフィックス付きで持つ）。前置詞なしはそのまま。 */
function decomposeChatId(chatId: string): string {
  return chatId.startsWith('chat#') ? chatId.slice('chat#'.length) : chatId;
}

// 上流の <output></output> 等 xml タグ除去（最初の対タグの中身だけ残す）。MIT 由来ロジック。
const OUTPUT_TAG = /<([^>]+)>([\s\S]*?)<\/\1>/;

/**
 * predictTitle（POST /predict/title、MIT 移植）。prompt から会話タイトルを生成し当該 chat へ書き戻す。
 *
 * 上流は (id=user#uid, createdDate) を DynamoDB 更新キーにした（本文 trust）。本リポ PK は chatId のため、
 * フロントが渡す chat.chatId を生 uuid に戻し、本人スコープ（findById で userId 一致）を確認してから
 * setTitle する（chats updateTitle と同じ認可ガード＝上流の暗黙 user# スコープを明示化）。不在は 404。
 * モデルはリクエスト指定（フロントが選択中モデルを送る）を優先し、未指定時のみ既定へ委譲する。これにより
 * 「選択モデルでチャット／タイトルとも生成」が成立し、低 RAM 機での既定モデル二重ロードを避けられる。応答はタイトル文字列。
 */
export function createPredictTitleHandler(deps: PredictDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { chat, prompt, id, model } = parseBody(predictTitleSchema, req.body);
    const chatId = decomposeChatId(chat.chatId);

    const owned = await deps.chats.findById(auth.userId, chatId);
    if (!owned) {
      throw notFound('チャットが見つかりません。');
    }

    let resolvedModel: string;
    try {
      resolvedModel = resolveTextModel(model);
    } catch (error) {
      modelNotAllowedAsBadRequest(error);
    }

    const raw = await deps.llm.generate({
      model: resolvedModel,
      messages: [{ role: 'user', content: prompt }],
      requestId: id,
    });
    const title = raw.replace(OUTPUT_TAG, '$2');

    await deps.chats.setTitle(chatId, title);
    return { status: 200, body: title };
  });
}

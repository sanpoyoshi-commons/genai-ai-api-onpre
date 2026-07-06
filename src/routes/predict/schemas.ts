import { z } from 'zod';

/** Model 指定（任意）。type はフロント契約のため受理するが解決は modelId のみ使う。 */
const modelSchema = z
  .object({
    type: z.enum(['bedrock', 'sagemaker']).optional(),
    modelId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .optional();

/** ExtraData（multimodal）は現状スコープ外だが、入力は素通し受理する。 */
const extraDataSchema = z.object({
  type: z.enum(['image', 'video', 'file', 'json']),
  name: z.string(),
  source: z.object({
    type: z.enum(['s3', 'base64', 'json']),
    mediaType: z.string(),
    data: z.string(),
  }),
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  trace: z.string().optional(),
  extraData: z.array(extraDataSchema).optional(),
  llmType: z.string().optional(),
});

/** predict / predictStream 入力。temperature は任意（未指定時は env 既定→バックエンド既定）。 */
export const predictSchema = z.object({
  model: modelSchema,
  messages: z.array(messageSchema),
  id: z.string(),
  // 構造化出力（ダイアグラム生成等）のため呼び出し側が低温を指定できる。0〜2。
  temperature: z.number().min(0).max(2).optional(),
});

/**
 * predictTitle 入力。上流の必須検証（prompt/chat.id/chat.createdDate/id）を zod へ移す。
 * 上流は DynamoDB の (id=user#uid, createdDate) を更新キーにしたが、本リポ PK は chatId のため
 * フロントが持つ Chat の chatId（"chat#uuid" 形）を受け、ハンドラで本人スコープ更新に使う。
 */
export const predictTitleSchema = z.object({
  model: modelSchema,
  chat: z
    .object({
      id: z.string().optional(),
      chatId: z.string().min(1),
      createdDate: z.string().min(1),
    })
    .passthrough(),
  prompt: z.string().min(1),
  id: z.string().min(1),
});

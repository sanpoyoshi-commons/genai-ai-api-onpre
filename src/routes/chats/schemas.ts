import { z } from 'zod';

/**
 * chats の入力検証（上流 `schemas/` のアイデア領域 + 本リポ独自命名・エラー文字列）。
 * createMessages の body は上流 ToBeRecordedMessage 配列。content(JSON) 内包属性も検証する。
 */
export const updateChatTitleSchema = z.object({
  title: z.string({ error: 'タイトルの形式が不正です。' }).trim().min(1, 'タイトルは必須です。'),
});

const extraDataSchema = z.object({
  type: z.enum(['image', 'video', 'file', 'json']),
  name: z.string(),
  source: z.object({
    type: z.enum(['s3', 'base64', 'json']),
    mediaType: z.string(),
    data: z.string(),
  }),
});

const toBeRecordedMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  trace: z.string().optional(),
  extraData: z.array(extraDataSchema).optional(),
  llmType: z.string().optional(),
  createdDate: z.string().optional(),
  messageId: z.string(),
  usecase: z.string(),
});

export const createMessagesSchema = z.object({
  messages: z.array(toBeRecordedMessageSchema),
});

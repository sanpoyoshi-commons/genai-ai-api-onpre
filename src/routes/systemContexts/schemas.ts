import { z } from 'zod';

// システムコンテキスト関連の入力バリデーションスキーマ。
export const createSystemContextSchema = z.object({
  systemContextTitle: z
    .string({ error: 'システムコンテキストタイトルの形式が不正です。' })
    .trim()
    .min(1, 'システムコンテキストタイトルは必須です。'),
  systemContext: z
    .string({ error: 'システムコンテキストの形式が不正です。' })
    .trim()
    .min(1, 'システムコンテキストは必須です。'),
});

export const updateSystemContextTitleSchema = z.object({
  title: z.string({ error: 'タイトルの形式が不正です。' }).trim().min(1, 'タイトルは必須です。'),
});

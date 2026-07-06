import { z } from 'zod';

/**
 * teams／exApps の入力検証（上流 `schemas/` のアイデア領域 + 本リポ独自命名・エラー文字列）。
 * フロント契約型（CreateTeamRequest/CreateExAppRequest 等）の必須/任意に合わせて確定する。
 */
export const createTeamSchema = z.object({
  teamName: z.string({ error: 'チーム名の形式が不正です。' }).trim().min(1, 'チーム名は必須です。'),
  teamAdminEmail: z.string({ error: 'メールアドレスの形式が不正です。' }).email('メールアドレスの形式が不正です。'),
});

export const updateTeamSchema = z.object({
  teamName: z.string({ error: 'チーム名の形式が不正です。' }).trim().min(1, 'チーム名は必須です。'),
});

const exAppStatusSchema = z.enum(['draft', 'published'], { error: '公開状態の値が不正です。' });

/** createExApp。apiKey は必須（作成時に常に保存）。 */
export const createExAppSchema = z.object({
  exAppName: z.string().trim().min(1, 'アプリ名は必須です。'),
  endpoint: z.string().trim().min(1, 'エンドポイントは必須です。'),
  config: z.string().optional(),
  placeholder: z.string(),
  systemPrompt: z.string().optional(),
  systemPromptKeyName: z.string().optional(),
  description: z.string(),
  howToUse: z.string(),
  apiKey: z.string(),
  copyable: z.boolean().optional(),
  status: exAppStatusSchema.optional(),
});

/** updateExApp。全項目任意（部分更新）。apiKey は指定時のみ更新。 */
export const updateExAppSchema = z.object({
  exAppName: z.string().optional(),
  endpoint: z.string().optional(),
  config: z.string().optional(),
  placeholder: z.string().optional(),
  systemPrompt: z.string().optional(),
  systemPromptKeyName: z.string().optional(),
  description: z.string().optional(),
  howToUse: z.string().optional(),
  apiKey: z.string().optional(),
  copyable: z.boolean().optional(),
  status: exAppStatusSchema.optional(),
});

/** copyExApp。endpoint と apiKey は複製元から引き継ぐためボディに取らない。 */
export const copyExAppSchema = z.object({
  exAppName: z.string().trim().min(1, 'アプリ名は必須です。'),
  config: z.string().optional(),
  placeholder: z.string(),
  systemPrompt: z.string().optional(),
  systemPromptKeyName: z.string().optional(),
  description: z.string(),
  howToUse: z.string(),
  copyable: z.boolean(),
  status: exAppStatusSchema,
});

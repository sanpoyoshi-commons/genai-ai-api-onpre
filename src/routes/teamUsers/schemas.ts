import { z } from 'zod';

/**
 * teamUsers の入力検証（上流 `schemas/` のアイデア領域 + 本リポ独自命名・エラー文字列）。
 */
export const createTeamUserSchema = z.object({
  email: z.string({ error: 'メールアドレスの形式が不正です。' }).email('メールアドレスの形式が不正です。'),
  isAdmin: z.boolean({ error: '管理者フラグの形式が不正です。' }),
});

export const updateTeamUserSchema = z.object({
  isAdmin: z.boolean({ error: '管理者フラグの形式が不正です。' }),
});

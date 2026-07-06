import { z } from 'zod';

/**
 * 源内独自 IF（Code Interpreter）の入力検証。
 *
 * リクエスト: { inputs: { input_text, files: [{ key, files: [{ filename, content(base64) }] }] } }
 * `key` は源内標準 IF 互換のためだけに存在し本 API では未使用（受理して破棄）。
 * **CSV/Excel 限定**（方針確定②）＝filename 拡張子で絞る。これは脅威面を狭める入力検証（補助）で、
 * 隔離の保証はサンドボックス側が担う。合計サイズ上限はハンドラで config を見て検査する（400）。
 */

const ALLOWED_EXT = ['.csv', '.xlsx', '.xls'];

function hasAllowedExt(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXT.some((e) => lower.endsWith(e));
}

// base64 形式の簡易チェック（厳密なデコード妥当性はハンドラの Buffer.from で実質再確認）。
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export function isLikelyBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && BASE64_RE.test(s);
}

const innerFileSchema = z.object({
  filename: z.string().min(1).refine(hasAllowedExt, 'CSV/Excel ファイル(.csv/.xlsx/.xls)のみ対応しています。'),
  content: z.string().refine(isLikelyBase64, 'content は base64 文字列である必要があります。'),
});

const fileGroupSchema = z.object({
  key: z.string().optional().default(''),
  files: z.array(innerFileSchema),
});

export const codeInterpreterSchema = z.object({
  inputs: z.object({
    input_text: z.string().min(1, 'input_text は必須です。'),
    files: z.array(fileGroupSchema).optional().default([]),
  }),
});

export type CodeInterpreterRequest = z.infer<typeof codeInterpreterSchema>;

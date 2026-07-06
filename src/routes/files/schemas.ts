import { z } from 'zod';

/**
 * アップロード署名 URL 要求（POST /file/url・/transcribe/url 共用）。上流 GetFileUploadSignedUrlRequest 互換。
 * filename は任意（未指定時はキーに uuid のみ）。mediaFormat はフロント契約で受理するが署名計算では未使用。
 */
export const uploadUrlSchema = z.object({
  filename: z.string().optional(),
  mediaFormat: z.string().optional(),
});

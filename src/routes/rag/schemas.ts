import { z } from 'zod';

/**
 * rag リソース群の入力スキーマ（zod 継続採用）。
 * ingest は -onpre 新規の clean な {title, text}。
 * query は上流 ExApp 契約 faithful の {inputs:{question}}（retrieve-and-generate）。
 */

export const ingestSchema = z.object({
  title: z.string().min(1, 'title is required'),
  text: z.string().min(1, 'text is required'),
});

export const querySchema = z.object({
  inputs: z.object({
    question: z.string().min(1, 'question is required'),
  }),
  // 回答生成モデル（任意・resolveTextModel で照合／既定委譲）。
  model: z.object({ modelId: z.string().optional() }).optional(),
});

export type IngestBody = z.infer<typeof ingestSchema>;
export type QueryBody = z.infer<typeof querySchema>;

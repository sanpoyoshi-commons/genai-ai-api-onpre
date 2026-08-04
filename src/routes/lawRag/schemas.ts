import { z } from 'zod';

/**
 * lawRag リソースの入力スキーマ（法令名ベース忠実ポート）。
 * 一般文書 RAG（rag/query）の retrieve-and-generate とは経路が別（法令名推定→法令特定→選別→レポート生成）。
 * 契約は rag/query を踏襲：{inputs:{question}}＋任意 model。
 */
export const lawQuerySchema = z.object({
  inputs: z.object({
    question: z.string().min(1, 'question is required'),
    // as-of：参照時点（YYYY-MM-DD）。未指定＝現行（as-of 導入前と同一・後方互換）。
    // 指定時は未施行条文も候補に含め、その時点で施行されている版を構造的に解決して返す。
    as_of_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'as_of_date must be YYYY-MM-DD')
      .optional(),
  }),
  // レポート生成・法令名推定・条文選別に使うモデル（任意・resolveTextModel で照合／既定委譲）。
  model: z.object({ modelId: z.string().optional() }).optional(),
});

export type LawQueryBody = z.infer<typeof lawQuerySchema>;

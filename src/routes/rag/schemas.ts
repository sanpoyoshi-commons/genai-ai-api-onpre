import { z } from 'zod';

/**
 * rag リソース群の入力スキーマ（zod 継続採用）。
 * ingest は -onpre 新規の clean な {title, text}。
 * query は上流 ExApp 契約 faithful の {inputs:{question}}（retrieve-and-generate）。
 * ナレッジ集（collections）と検索だけ（search）は -onpre 新規。
 */

/** 名前と説明の長さの上限（画面の入力欄と合わせる）。 */
const NAME_MAX = 100;
const DESCRIPTION_MAX = 1000;
const TITLE_MAX = 200;
/** 検索クエリの長さの上限（embedding へそのまま渡すため、長すぎるものは断る）。 */
const QUERY_MAX = 1000;
/** 一度に絞り込めるナレッジ集の数（IN 句に入れる数の上限）。 */
const COLLECTION_IDS_MAX = 50;
/** 検索で返す最大件数の上限。 */
const TOP_K_MAX = 50;

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
  // 対象のナレッジ集（任意・未指定なら自分のすべて）。上流 ExApp 契約の inputs は変えず、外側に足す。
  collectionIds: z.array(z.string().min(1)).max(COLLECTION_IDS_MAX).optional(),
});

export const collectionCreateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(NAME_MAX, 'name is too long'),
  description: z.string().max(DESCRIPTION_MAX, 'description is too long').optional(),
});

export const collectionUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'name must not be empty').max(NAME_MAX, 'name is too long').optional(),
    description: z.string().max(DESCRIPTION_MAX, 'description is too long').optional(),
  })
  .refine((d) => d.name !== undefined || d.description !== undefined, {
    message: 'name or description is required',
  });

/** 原本（Bronze）への署名付き PUT URL の要求。キーは api が決める（所有者の sub が先頭）。 */
export const knowledgeUploadUrlSchema = z.object({
  filename: z.string().trim().min(1, 'filename is required').max(255, 'filename is too long'),
});

/**
 * 投入。`{bronzeKey}`（署名付き URL で上げた原本を読む）か `{title, text}`（貼り付けたテキスト）の
 * どちらか一方。bronzeKey のときの title は任意（未指定なら元のファイル名）。
 */
export const knowledgeIngestSchema = z
  .object({
    title: z.string().trim().min(1, 'title must not be empty').max(TITLE_MAX, 'title is too long').optional(),
    bronzeKey: z.string().min(1, 'bronzeKey must not be empty').max(1024, 'bronzeKey is too long').optional(),
    text: z.string().min(1, 'text must not be empty').optional(),
  })
  .refine((d) => (d.bronzeKey === undefined) !== (d.text === undefined), {
    message: 'either bronzeKey or text is required',
  })
  .refine((d) => d.bronzeKey !== undefined || d.title !== undefined, {
    message: 'title is required when text is given',
  });

/**
 * 回答と参照を構造で返す（`/rag/ask`）。上流契約の `inputs` 包みは持たない＝本リポ独自の clean な形。
 * 絞り込みとモデルの受け方は `/rag/query` と同じ。
 */
export const askSchema = z.object({
  question: z.string().trim().min(1, 'question is required'),
  model: z.object({ modelId: z.string().optional() }).optional(),
  collectionIds: z.array(z.string().min(1)).max(COLLECTION_IDS_MAX).optional(),
});

/** 検索だけ（生成しない）。0 件は results: [] を返す。 */
export const searchSchema = z.object({
  query: z.string().trim().min(1, 'query is required').max(QUERY_MAX, 'query is too long'),
  collectionIds: z.array(z.string().min(1)).max(COLLECTION_IDS_MAX).optional(),
  topK: z.number().int().min(1).max(TOP_K_MAX).optional(),
});

export type IngestBody = z.infer<typeof ingestSchema>;
export type QueryBody = z.infer<typeof querySchema>;
export type CollectionCreateBody = z.infer<typeof collectionCreateSchema>;
export type CollectionUpdateBody = z.infer<typeof collectionUpdateSchema>;
export type KnowledgeIngestBody = z.infer<typeof knowledgeIngestSchema>;
export type SearchBody = z.infer<typeof searchSchema>;
export type AskBody = z.infer<typeof askSchema>;

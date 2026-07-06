import type { Request } from 'express';
import type { ZodType } from 'zod';
import { badRequest } from './errors.js';

/**
 * 入力検証ヘルパ（zod 継続採用）。上流 schemas 資産と z.infer 型の互換保全方針に沿い、
 * safeParse の最初の issue を 400 にする。ヘルパ名・エラー文字列は本リポ独自命名。
 */
export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(result.error.issues[0]?.message ?? 'invalid request body');
  }
  return result.data;
}

export function requirePathParam(req: Request, name: string): string {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') {
    throw badRequest(`missing path parameter: ${name}`);
  }
  return value;
}

export function requireQueryParam(req: Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== 'string' || value === '') {
    throw badRequest(`missing query parameter: ${name}`);
  }
  return value;
}

export function getQueryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

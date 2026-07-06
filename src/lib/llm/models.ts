import { badRequest } from '../http/errors.js';

/** リクエスト由来のモデル指定（構造のみ）。type はローカルでは未使用、modelId のみ照合する。 */
type RequestedModel = { modelId?: unknown };

/**
 * 利用可能モデルの解決（上流 allowedModels.ts / models.ts のアイデア領域、MIT）。
 *
 * 上流は env `MODEL_IDS`（JSON 配列）の許可リストに対してリクエストの modelId を照合し、軽量モデルを
 * 既定にする。ローカルも同方式（経路＝バックエンドは `LLM_BACKEND` が決める、type は照合しない）。
 * 許可リスト未設定時はリクエスト modelId を素通し、modelId も既定も無い場合のみ 400。
 * エラー文言は上流由来（MIT 再利用可）。predictStream は専用ストリームで握るため判定用エラーを公開する。
 */

/** 上流由来のモデル不許可メッセージ（MIT 再利用）。 */
export const MODEL_NOT_ALLOWED_MESSAGE = 'このモデルは使用できません。';

/** モデル不許可（predictStream が JSONL 専用ストリームへ握るため型で識別する）。 */
export class ModelNotAllowedError extends Error {
  constructor() {
    super(MODEL_NOT_ALLOWED_MESSAGE);
    this.name = 'ModelNotAllowedError';
  }
}

export function isModelNotAllowedError(error: unknown): error is ModelNotAllowedError {
  return error instanceof ModelNotAllowedError;
}

function parseAllowedModelIds(): string[] {
  try {
    const raw = JSON.parse(process.env.MODEL_IDS ?? '[]') as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((m) => String(m).trim()).filter((m) => m.length > 0);
  } catch {
    return [];
  }
}

/**
 * テキストモデル解決。リクエスト model（任意）の modelId を許可リストに照合し、解決済み modelId を返す。
 * 不許可・既定不在は ModelNotAllowedError（predict は 400、predictStream は専用ストリーム）。
 */
export function resolveTextModel(requested?: RequestedModel): string {
  const allowed = parseAllowedModelIds();
  const defaultModelId = process.env.LLM_DEFAULT_MODEL?.trim() || allowed[0];

  const requestedId =
    typeof requested?.modelId === 'string' && requested.modelId.length > 0
      ? requested.modelId
      : undefined;

  // モデル未指定時は既定（env）へ。既定も無ければ空文字を返し、実バックエンド（LLM_BACKEND）の既定に委ねる
  // （個人開発者の単一モデル運用を 400 で阻害しない）。
  if (!requestedId) {
    return defaultModelId ?? '';
  }

  // 許可リストが設定されている場合のみ照合（未設定時は素通し）。
  if (allowed.length > 0 && !allowed.includes(requestedId)) {
    throw new ModelNotAllowedError();
  }
  return requestedId;
}

/**
 * Code Interpreter のコード生成 LLM モデル解決。源内 IF にモデル指定欄が無いため、リクエスト入力は取らず
 * env のみで決める：`CODE_INTERPRETER_MODEL`（このユースケース専用既定・モデルメニュー階層連動）→ `LLM_DEFAULT_MODEL`
 * → 空文字（実バックエンドの既定に委ねる）。CPU 機は cloud-api のコード生成 LLM、GPU/上位帯は局所モデルを env で当てる運用。
 */
export function resolveCodeInterpreterModel(): string {
  return process.env.CODE_INTERPRETER_MODEL?.trim() || process.env.LLM_DEFAULT_MODEL?.trim() || '';
}

/** ModelNotAllowedError を 400 へ写像する（predict 等、非ストリーミング経路用）。 */
export function modelNotAllowedAsBadRequest(error: unknown): never {
  if (isModelNotAllowedError(error)) {
    throw badRequest(error.message);
  }
  throw error;
}

import { ModelNotAllowedError } from '../llm/models.js';

/** リクエスト由来のモデル指定（構造のみ）。type はローカルでは未使用、modelId のみ照合する。 */
type RequestedModel = { modelId?: unknown };

/**
 * 画像生成モデルの解決（上流 allowedModels.resolveAllowedImageModel のアイデア領域、MIT）。
 * env `IMAGE_GENERATION_MODEL_IDS`（JSON 配列）の許可リストに照合。未設定時はリクエスト modelId 素通し、
 * modelId も既定も無い場合のみ不許可。判定エラーは LLM 共通の ModelNotAllowedError を再利用する。
 */
function parseAllowedImageModelIds(): string[] {
  try {
    const raw = JSON.parse(process.env.IMAGE_GENERATION_MODEL_IDS ?? '[]') as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((m) => String(m).trim()).filter((m) => m.length > 0);
  } catch {
    return [];
  }
}

export function resolveImageModel(requested?: RequestedModel): string {
  const allowed = parseAllowedImageModelIds();
  const defaultModelId = process.env.IMAGE_DEFAULT_MODEL?.trim() || allowed[0];

  const requestedId =
    typeof requested?.modelId === 'string' && requested.modelId.length > 0
      ? requested.modelId
      : undefined;

  // モデル未指定時は既定（env）へ。既定も無ければ空文字を返し、実バックエンドの既定に委ねる。
  if (!requestedId) {
    return defaultModelId ?? '';
  }
  if (allowed.length > 0 && !allowed.includes(requestedId)) {
    throw new ModelNotAllowedError();
  }
  return requestedId;
}

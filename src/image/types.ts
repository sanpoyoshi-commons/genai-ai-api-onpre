/**
 * 画像生成の型（標準化された GenerateImageParams のアイデア領域＝MIT／sd.cpp ワイヤ形式）。
 *
 * 3 層：
 *  1. SourceImageParams … GenerateImageParams 相当（フロントが送る標準化パラメータ。フロント無改修）。
 *  2. ImageGenRequest  … バックエンド非依存の正規化リクエスト（paramMapper の出力・adapter の入力）。
 *  3. sd.cpp ワイヤ型   … sdcppAdapter が ImageGenRequest から組み立てる /sdcpp/v1/img_gen の JSON。
 */

/** 標準化された taskType（AmazonAPIImageGenerationMode 相当）。sd.cpp 非対応モードは paramMapper が 501 で弾く。 */
export type SourceTaskType =
  | 'TEXT_IMAGE'
  | 'IMAGE_VARIATION'
  | 'INPAINTING'
  | 'OUTPAINTING'
  | 'COLOR_GUIDED_GENERATION'
  | 'BACKGROUND_REMOVAL';

/** 重み付きプロンプト要素。 */
export interface SourceTextPrompt {
  text: string;
  weight: number;
}

/**
 * GenerateImageParams のうちローカルで解釈する項目（標準化パラメータ・MIT アイデア領域）。
 * ルートは params を opaque に渡すため、paramMapper が本形へ検証する。未知フィールドは無視する。
 */
export interface SourceImageParams {
  taskType?: SourceTaskType;
  textPrompt: SourceTextPrompt[];
  cfgScale?: number;
  seed?: number;
  step?: number;
  stylePreset?: string;
  imageStrength?: number;
  height?: number;
  width?: number;
  // Image to Image / Inpainting
  initImage?: string; // base64
  maskImage?: string; // base64
  maskPrompt?: string; // 自然言語マスク（SAM 等が要る＝sd.cpp 非対応）
  // Image Conditioning（ControlNet）
  controlStrength?: number;
  controlMode?: 'CANNY_EDGE' | 'SEGMENTATION';
  // Color Guided Generation（sd.cpp 非対応）
  colors?: string[];
}

/** 正規化リクエストのモード（sd.cpp 能力内）。 */
export type ImageGenMode = 'txt2img' | 'img2img' | 'inpaint' | 'controlnet';

/**
 * バックエンド非依存の正規化リクエスト。paramMapper が SourceImageParams から生成し、adapter が経路 JSON へ写す。
 * 重みは prompt/negativePrompt へ振り分け済（SD 注意記法 `(text:weight)`）。
 */
export interface ImageGenRequest {
  /** 解決済みモデル ID（情報用。sd-server は起動時に 1 モデルをロードするため通常は照合のみ）。 */
  model: string;
  mode: ImageGenMode;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  /** img2img の初期画像（base64）。 */
  initImage?: string;
  /** img2img の変化強度（SourceImageParams.imageStrength 由来）。 */
  strength?: number;
  /** inpaint のマスク画像（base64）。 */
  maskImage?: string;
  /** ControlNet の条件画像（base64）。 */
  controlImage?: string;
  controlStrength?: number;
}

// ---- sd.cpp ネイティブ API ワイヤ型（examples/server/api.md より） ----------------------------

/** POST /sdcpp/v1/img_gen のリクエスト（api.md 準拠）。 */
export interface SdcppImgGenRequest {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  seed?: number; // -1 でランダム
  batch_count?: number;
  sample_params?: {
    sample_steps?: number;
    sample_method?: string;
    guidance?: { txt_cfg?: number };
  };
  strength?: number;
  init_image?: string | null;
  mask_image?: string | null;
  control_image?: string | null;
  control_strength?: number;
}

/** POST /sdcpp/v1/img_gen の 202 応答。 */
export interface SdcppJobAccepted {
  id: string;
  kind?: string;
  status?: string;
  poll_url?: string;
}

/** GET /sdcpp/v1/jobs/{id} の応答。status: queued/generating/completed/failed/cancelled。 */
export interface SdcppJobStatus {
  id: string;
  status: string;
  result?: {
    output_format?: string;
    images?: { index?: number; b64_json?: string }[];
  };
  error?: string;
}

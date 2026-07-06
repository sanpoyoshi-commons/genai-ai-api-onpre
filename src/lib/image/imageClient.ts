/**
 * 画像生成の seam（seam 注入＋実バックエンド配線は後続）。
 *
 * 上流は `api[model.type].generateImage(model, params)`（Bedrock 画像モデル）で base64 画像を返す。LLM
 * 抽象化は画像生成を明示スコープ外とする（テキスト生成 IF とは別モダリティ）。ローカル代替の OSS が
 * 未確定のため、ここではインターフェースのみ定義して deps 注入し、実バックエンドは選定後に配線する。
 * unit テストは fake を注入する。
 */

export interface ImageGenerateInput {
  /** 解決済み画像モデル ID。 */
  model: string;
  /** 画像生成パラメータ（バックエンドへ素通し）。 */
  params: Record<string, unknown>;
}

export interface ImageClient {
  /** 画像を生成し base64 文字列で返す（上流 generateImage 相当）。 */
  generateImage(input: ImageGenerateInput): Promise<string>;
}

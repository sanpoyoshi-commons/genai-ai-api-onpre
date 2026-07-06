import type { ImageGenRequest } from '../types.js';

/**
 * 画像生成アダプタの抽象 IF（LLMAdapter と対称）。
 *
 * factory が IMAGE_BACKEND に応じた実装を返す。正規化リクエスト（ImageGenRequest）を受け取り、経路 API へ写して
 * base64 画像 1 枚を返す。SourceImageParams → ImageGenRequest の写像は paramMapper の責務（経路非依存）。
 */
export interface ImageAdapter {
  readonly backend: string;
  /** 画像を生成し base64 文字列で返す。 */
  generate(request: ImageGenRequest): Promise<string>;
}

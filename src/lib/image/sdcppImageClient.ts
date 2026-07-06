import type { ImageAdapter } from '../../image/adapters/base.js';
import { createImageAdapter } from '../../image/factory.js';
import { mapToImageGenRequest } from '../../image/paramMapper.js';
import type { ImageClient, ImageGenerateInput } from './imageClient.js';

/**
 * ImageClient seam の実装＝画像生成レイヤー（src/image/）への委譲ブリッジ。
 *
 * skeleton 実装を置き換える。seam（generateImage: Promise<string>）を維持し背後に
 * paramMapper（上流 GenerateImageParams → 正規化）＋ adapter（sd.cpp ネイティブ img_gen+poll）を置くため、
 * ルート #14 は無改修（エラー写像のみ追加）。アダプタは lazy 生成（未配線でも app 起動可・初回生成時に config
 * 解決＝LlmAbstractionClient/SeaweedFsStorage と同方式）。adapterFactory は注入可能（unit は fake adapter 注入）。
 */
export class SdcppImageClient implements ImageClient {
  private adapter?: ImageAdapter;

  constructor(private readonly adapterFactory: () => ImageAdapter = () => createImageAdapter()) {}

  private get(): ImageAdapter {
    if (!this.adapter) {
      this.adapter = this.adapterFactory();
    }
    return this.adapter;
  }

  generateImage(input: ImageGenerateInput): Promise<string> {
    const request = mapToImageGenRequest(input.model, input.params);
    return this.get().generate(request);
  }
}

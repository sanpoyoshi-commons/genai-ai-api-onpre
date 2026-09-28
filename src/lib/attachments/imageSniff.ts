/**
 * 画像の**中身**の判定と寸法の読み取り（依存なし）。
 *
 * モデルへ渡してよいのは PNG と JPEG だけ（2026-09-27 の決定）。理由は2つ。
 *  1. Ollama v0.31.2 が同梱する `golang.org/x/image` v0.22.0 に webp の既知の脆弱性が2件ある
 *     （GO-2026-5061・CVE-2026-46603＝panic とメモリ枯渇の DoS。上げ先なし）。
 *  2. Ollama は `Serve()` で webp のデコーダを `image.RegisterFormat` で登録する。登録は
 *     **中身の先頭で形式を選ぶ**ので、`image/png` と名乗った webp でもデコーダに届く。
 *     ⇒ 名乗り（mediaType）だけを見る検査では防げない。**中身で判定する。**
 *
 * 寸法の上限は定数で持つ（env にしない＝緩められると上の防御が意味を失う）。
 */

/** 各辺の上限（px）。 */
export const MAX_IMAGE_SIDE = 10000;
/** 画素数の上限。RGBA へ展開して約 100MB に相当する。 */
export const MAX_IMAGE_PIXELS = 25_000_000;

export type ImageFormat = 'png' | 'jpeg';

export interface SniffedImage {
  format: ImageFormat;
  width: number;
  height: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

function be16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function be32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) * 0x1000000 + ((bytes[at + 1] ?? 0) << 16)) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
  );
}

/** PNG の IHDR（先頭チャンクであることが仕様で決まっている）から幅と高さを読む。 */
function sniffPng(bytes: Uint8Array): SniffedImage | undefined {
  // 8:magic / 12:IHDR チャンクのヘッダ（長さ4＋型4）/ 16:幅 / 20:高さ
  if (bytes.length < 24) {
    return undefined;
  }
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') {
    return undefined;
  }
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { format: 'png', width, height };
}

/** SOF マーカ（フレームの開始）を探して高さと幅を読む。 */
function sniffJpeg(bytes: Uint8Array): SniffedImage | undefined {
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      // マーカの並びが壊れている。
      return undefined;
    }
    const marker = bytes[i + 1] ?? 0;
    // 詰め物の 0xFF は読み飛ばす。
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // スタンドアロンのマーカ（長さを持たない）。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // 走査の開始・画像の終わり。ここまでに SOF が無ければ読めない。
    if (marker === 0xda || marker === 0xd9) {
      return undefined;
    }
    const segmentLength = be16(bytes, i + 2);
    if (segmentLength < 2 || i + 2 + segmentLength > bytes.length) {
      return undefined;
    }
    // SOF0〜SOF15。ただし DHT(C4)・DNL(C8)・DAC(CC) はフレームではない。
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = be16(bytes, i + 5);
      const width = be16(bytes, i + 7);
      if (width <= 0 || height <= 0) {
        return undefined;
      }
      return { format: 'jpeg', width, height };
    }
    i += 2 + segmentLength;
  }
  return undefined;
}

/**
 * 中身から形式と寸法を読む。PNG・JPEG 以外、または読み取れないものは undefined。
 * 「読み取れない」は呼び出し側が error の注記にする（黙って渡さない）。
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  if (startsWith(bytes, PNG_MAGIC)) {
    return sniffPng(bytes);
  }
  if (startsWith(bytes, JPEG_MAGIC)) {
    return sniffJpeg(bytes);
  }
  return undefined;
}

/** 寸法が上限に収まるか。 */
export function isWithinImageLimits(image: SniffedImage): boolean {
  return (
    image.width <= MAX_IMAGE_SIDE && image.height <= MAX_IMAGE_SIDE && image.width * image.height <= MAX_IMAGE_PIXELS
  );
}

/** mediaType（名乗り）を形式へ写す。PNG・JPEG 以外は undefined。 */
export function formatOfMediaType(mediaType: string): ImageFormat | undefined {
  const media = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  if (media === 'image/png') {
    return 'png';
  }
  if (media === 'image/jpeg' || media === 'image/jpg') {
    return 'jpeg';
  }
  return undefined;
}

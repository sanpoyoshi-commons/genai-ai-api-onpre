import mammoth from 'mammoth';

/**
 * docx から本文の文字を取り出す（mammoth 1.12.3・BSD-2-Clause）。
 *
 * **`extractRawText` だけを使う**。HTML への変換（`convertToHtml`）と画像の取り出しは
 * 使わない。CVE-2025-11849 は 1.11.0 で直っているが、外部の参照をたどる機能に近づかない方針。
 * `extractRawText` は段落を改行で連結するだけで、スタイルも画像も追わない。
 *
 * mammoth は自分で例外を投げる（壊れた zip・docx でないファイル）。呼び出し側が注記へ変える。
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value.replace(/\r\n?/g, '\n').trim();
}

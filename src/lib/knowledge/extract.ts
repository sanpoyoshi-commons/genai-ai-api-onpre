import {
  detectKind,
  type DocumentKind,
  DOCX_MEDIA_TYPE,
  extensionOf,
  extractorVersionLabel,
  extractTextFromBytes,
  XLSX_MEDIA_TYPE,
} from '../attachments/extractText.js';
import type { KnowledgeLimits } from './config.js';

/**
 * ナレッジ集へ投入する原本から、抽出テキスト（と記録する形式）を作る層。
 *
 * 本文の取り出しそのものはチャットの添付と同じ抽出器（`../attachments/extractText.ts`）を使う。
 * 違うのは上限の扱い＝**超えたら切り詰めずに断る**（`rejected`）。添付は文脈長に収めるために切り詰めるが、
 * ナレッジ集で後半が黙って欠けると、検索で出てこない理由が利用者から見えないため。
 *
 * 結果は 3 つに分かれる。
 * - `ok`：抽出テキストができた。チャンク化へ進む。
 * - `rejected`：投入を断る（形式が読めない・上限を超えた・中身が名乗りと違う）。文書は作らず原本も消す。
 * - `failed`：読める形式なのに今の抽出器では文字が取れなかった（壊れている・パスワード・画像だけの PDF 等）。
 *   文書は `status="failed"` で作り、**原本は残す**（抽出器を良くしたときに作り直せるようにするため）。
 */

export type KnowledgeExtractOutcome =
  | {
      kind: 'ok';
      text: string;
      charCount: number;
      /** 中身を見て決めた形式。 */
      mime: string;
      extractor: string;
      /** `<ライブラリの版>+r<抽出規則の版>`（`extractorVersionLabel`）。 */
      extractorVersion: string;
    }
  | { kind: 'rejected'; reason: KnowledgeRejectReason; message: string }
  | {
      kind: 'failed';
      message: string;
      mime: string;
      extractor?: string;
      extractorVersion?: string;
    };

export type KnowledgeRejectReason =
  | 'unsupported'
  | 'content_mismatch'
  | 'too_large'
  | 'too_many_pages'
  | 'too_many_chars'
  | 'timeout';

/** 入れ物の種類（先頭のバイト列で見る）。 */
export type Container = 'pdf' | 'zip' | 'image' | 'unknown';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]; // "GIF8"
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]; // "RIFF"（webp の外枠）

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.byteLength < magic.length) {
    return false;
  }
  return magic.every((b, i) => bytes[i] === b);
}

/**
 * 先頭のバイト列で入れ物の種類を見る。**名乗り（拡張子・media type）を信じない**ための判定。
 * JPEG は SOI マーカー（FF D8 FF）で見る。
 */
export function sniffContainer(bytes: Uint8Array): Container {
  if (startsWith(bytes, PDF_MAGIC)) {
    return 'pdf';
  }
  if (startsWith(bytes, ZIP_MAGIC)) {
    return 'zip';
  }
  if (
    startsWith(bytes, PNG_MAGIC) ||
    startsWith(bytes, GIF_MAGIC) ||
    startsWith(bytes, RIFF_MAGIC) ||
    (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
  ) {
    return 'image';
  }
  return 'unknown';
}

/** 読める区分について、記録する形式を決める。 */
function mimeOf(kind: Exclude<DocumentKind, 'image' | 'unsupported'>, filename: string): string {
  switch (kind) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return DOCX_MEDIA_TYPE;
    case 'xlsx':
      return XLSX_MEDIA_TYPE;
    case 'html':
      return 'text/html';
    default: {
      const ext = extensionOf(filename);
      if (ext === 'md' || ext === 'markdown') {
        return 'text/markdown';
      }
      if (ext === 'csv') {
        return 'text/csv';
      }
      return 'text/plain';
    }
  }
}

/** 名乗った区分と中身の入れ物が食い違っていないか。 */
function containerMatches(
  kind: Exclude<DocumentKind, 'image' | 'unsupported'>,
  container: Container,
): boolean {
  if (kind === 'pdf') {
    return container === 'pdf';
  }
  if (kind === 'docx' || kind === 'xlsx') {
    return container === 'zip';
  }
  // text・html は入れ物を持たない。PDF・zip・画像の中身が来ていたら名乗りが嘘（文字化けを貯めない）。
  return container === 'unknown';
}

/**
 * 原本のバイト列から抽出テキストを作る。
 *
 * 文字数の上限は「超えたことを見分ける」ために 1 文字だけ余らせて読み、読めた長さで判定する
 * （抽出器は上限に達したところで読むのをやめるため、上限ちょうどで止まると「ちょうど収まった」のか
 * 「切られた」のかが区別できない）。ページ数は PDF 全体のページ数で判定する。
 */
export async function extractKnowledgeText(
  bytes: Uint8Array,
  filename: string,
  declaredMediaType: string,
  limits: KnowledgeLimits,
  now?: () => number,
): Promise<KnowledgeExtractOutcome> {
  if (bytes.byteLength > limits.maxBytes) {
    return {
      kind: 'rejected',
      reason: 'too_large',
      message: `ファイルが大きすぎます（上限 ${limits.maxBytes} バイト）。`,
    };
  }

  const kind = detectKind(filename, declaredMediaType);
  if (kind === 'image' || kind === 'unsupported') {
    return {
      kind: 'rejected',
      reason: 'unsupported',
      message:
        'この形式は取り込めません。pdf・docx・xlsx・txt・md・csv・html のいずれかにしてください（画像は文字が取れないため受け付けません）。',
    };
  }

  const container = sniffContainer(bytes);
  if (!containerMatches(kind, container)) {
    return {
      kind: 'rejected',
      reason: 'content_mismatch',
      message: '拡張子と中身が合いません。元のファイルの形式を確かめてください。',
    };
  }

  const mime = mimeOf(kind, filename);
  const extraction = await extractTextFromBytes(
    bytes,
    kind,
    {
      maxPages: limits.maxPages,
      // 上限を超えたことを見分けるため 1 文字だけ余らせて読む。
      maxChars: limits.maxChars + 1,
      parseTimeoutMs: limits.parseTimeoutMs,
    },
    { now },
  );

  if (extraction.status === 'timeout') {
    return {
      kind: 'rejected',
      reason: 'timeout',
      message: `解析に時間がかかりすぎたため取り込みませんでした（上限 ${limits.parseTimeoutMs} ミリ秒）。`,
    };
  }
  if (extraction.status === 'too_large') {
    return {
      kind: 'rejected',
      reason: 'too_large',
      message: '展開すると大きすぎるため取り込みませんでした。',
    };
  }
  if (extraction.status !== undefined) {
    // error・no_text＝読める形式なのに文字が取れなかった。原本を残して作り直せるようにする。
    return {
      kind: 'failed',
      message: extraction.note ?? '本文を取り出せませんでした。',
      mime,
      extractor: extraction.extractor?.name,
      extractorVersion: extraction.extractor
        ? extractorVersionLabel(extraction.extractor)
        : undefined,
    };
  }

  if ((extraction.pages ?? 0) > limits.maxPages) {
    return {
      kind: 'rejected',
      reason: 'too_many_pages',
      message: `ページ数が多すぎます（${extraction.pages} ページ・上限 ${limits.maxPages} ページ）。`,
    };
  }
  const charCount = extraction.text.length;
  if (charCount > limits.maxChars) {
    return {
      kind: 'rejected',
      reason: 'too_many_chars',
      message: `文字数が多すぎます（上限 ${limits.maxChars} 文字）。文書を分けて取り込んでください。`,
    };
  }

  return {
    kind: 'ok',
    text: extraction.text,
    charCount,
    mime,
    extractor: extraction.extractor?.name ?? 'unknown',
    extractorVersion: extraction.extractor ? extractorVersionLabel(extraction.extractor) : 'unknown',
  };
}

import { extractDocxText } from './docxText.js';
import { extractHtmlText } from './htmlText.js';
import { extractPdfText, PdfTimeoutError } from './pdfText.js';
import { decodeText } from './textDecode.js';
import { extractXlsxText } from './xlsxText.js';
import { checkZip } from './zipGuard.js';

/**
 * バイト列から本文を取り出す層（形式の判定・zip の検査・時間切れを含む）。
 *
 * チャットの添付（`index.ts`。base64 で届き、文脈長に合わせた小さな上限で読む）と、ナレッジ集の投入
 * （`../knowledge/`。オブジェクトストレージから読み、もっと大きな上限で読む）の両方がここを使う。
 * 上限（ページ数・文字数・打ち切り時間）は呼び出し側が渡す＝経路ごとに別の環境変数で持てる。
 *
 * どの抽出器で読んだかを名前と版で返す。版はナレッジ集の抽出テキストに記録し、抽出器を良くしたときに
 * 「どの文書を作り直すか」を選べるようにする。
 */

/** 中身の読み方の区分。`image` は本文を取り出さない（呼び出し側が扱いを決める）。 */
export type DocumentKind = 'pdf' | 'text' | 'html' | 'docx' | 'xlsx' | 'image' | 'unsupported';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv']);
const TEXT_MEDIA_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/csv',
]);
const HTML_EXTENSIONS = new Set(['html', 'htm']);
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);
export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/**
 * 画像として扱う名乗り。**渡してよいのは PNG と JPEG だけ**だが、webp・gif も「画像」として拾って
 * `unsupported` の注記にする（黙って落とさないため。実際に渡すかは imageSniff が中身で決める）。
 */
export const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 名乗り（ファイル名の拡張子と media type）から読み方の区分を決める。 */
export function detectKind(name: string, mediaType: string): DocumentKind {
  const ext = extensionOf(name);
  const media = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  if (ext === 'pdf' || media === 'application/pdf') {
    return 'pdf';
  }
  if (ext === 'docx' || media === DOCX_MEDIA_TYPE) {
    return 'docx';
  }
  if (ext === 'xlsx' || media === XLSX_MEDIA_TYPE) {
    return 'xlsx';
  }
  if (HTML_EXTENSIONS.has(ext) || HTML_MEDIA_TYPES.has(media)) {
    return 'html';
  }
  if (IMAGE_MEDIA_TYPES.has(media)) {
    return 'image';
  }
  if (TEXT_EXTENSIONS.has(ext) || TEXT_MEDIA_TYPES.has(media)) {
    return 'text';
  }
  return 'unsupported';
}

/** 本文の取り出しの上限（経路ごとに別の環境変数から作る）。 */
export interface TextExtractLimits {
  /** PDF のページ数の上限。 */
  maxPages: number;
  /** 文字数の上限（PDF・xlsx は上限に達したところで読むのをやめる）。 */
  maxChars: number;
  /** 1 件あたりの打ち切り時間（ms）。 */
  parseTimeoutMs: number;
}

export interface TextExtractDeps {
  /** 時計。既定は Date.now。テストが時間切れを決定的に起こすための seam。 */
  now?: () => number;
}

/** 使った抽出器（名前・ライブラリの版・抽出規則の版）。 */
export interface ExtractorInfo {
  name: string;
  /** ライブラリの版。`package.json` の依存の版と同じ数にする。 */
  version: string;
  /**
   * 抽出規則の版。**ライブラリの版とは無関係に、この区分の取り出し方を変えたときだけ 1 つ上げる**
   * （同じライブラリの版でも、出てくるテキストが変わるため）。
   */
  rules: number;
}

/**
 * 区分ごとの抽出器と版。`version` は **`package.json` の依存の版と同じ数にすること**。
 * 対になっていることは `tests/lib/attachments/extractText.test.ts` が `package.json` を読んで確かめる
 * （版を上げたときにここだけ古いまま残ると、抽出テキストに嘘の版が残るため）。
 * `text` は外部の依存を使わない（Node の TextDecoder＝`textDecode.ts`）ので版は固定の 1。
 *
 * `rules` の履歴：
 * - `html` は `<pre>` の改行と字下げを保つようにしたため 2（それまでは 1 行に潰れていた）。
 * - ほかの区分は取り出し方を変えていないので 1。
 */
export const EXTRACTORS: Record<Exclude<DocumentKind, 'image' | 'unsupported'>, ExtractorInfo> = {
  pdf: { name: 'pdfjs-dist', version: '6.3.289', rules: 1 },
  docx: { name: 'mammoth', version: '1.12.3', rules: 1 },
  xlsx: { name: 'read-excel-file', version: '9.3.10', rules: 1 },
  html: { name: 'node-html-parser', version: '9.0.4', rules: 2 },
  text: { name: 'text-decode', version: '1', rules: 1 },
};

/**
 * 抽出テキストと一緒に記録する版の文字列＝`<ライブラリの版>+r<抽出規則の版>`（例 `9.0.4+r2`）。
 *
 * ライブラリの版だけでは、取り出し方を変えた前と後で作ったテキストを見分けられない。
 * `+r` を見て作り直す対象を選べるようにする。**`+r` が付いていない記録は、この形にする前のもの**。
 */
export function extractorVersionLabel(extractor: ExtractorInfo): string {
  return `${extractor.version}+r${extractor.rules}`;
}

/** 取り出しの結果。`status` が付いているときは本文が無く、`note` に理由の 1 行が入る。 */
export interface TextExtraction {
  text: string;
  /** PDF 全体のページ数。 */
  pages?: number;
  /** 実際に読んだページ数。 */
  extractedPages?: number;
  /** ページ数・文字数・時間のいずれかで打ち切ったか。 */
  truncated?: boolean;
  /** 本文を出せない理由。`unsupported` / `too_large` / `error` / `timeout` / `no_text`。 */
  status?: string;
  /** status のときに人（とモデル）へ見せる 1 行。 */
  note?: string;
  /** 使った抽出器（区分が image・unsupported のときは undefined）。 */
  extractor?: ExtractorInfo;
}

/**
 * バイト列から本文を取り出す。区分は呼び出し側が `detectKind` で決めてから渡す
 * （呼び出し側は区分ごとに別の扱い＝画像を渡す／断る、を先に決める必要があるため）。
 *
 * 失敗は例外にせず `status` 付きの結果に変える（呼び出し側が注記や取り込み失敗として扱う）。
 * docx・xlsx は zip なので、解析へ渡す前に宣言された展開後サイズとエントリ数で弾く（zip 爆弾）。
 */
export async function extractTextFromBytes(
  bytes: Uint8Array,
  kind: Exclude<DocumentKind, 'image' | 'unsupported'>,
  limits: TextExtractLimits,
  deps: TextExtractDeps = {},
): Promise<TextExtraction> {
  const extractor = EXTRACTORS[kind];

  if (kind === 'docx' || kind === 'xlsx') {
    const verdict = checkZip(bytes);
    if (!verdict.ok) {
      return verdict.reason === 'too_large'
        ? {
            text: '',
            status: 'too_large',
            note: '展開すると大きすぎるため解析しませんでした。',
            extractor,
          }
        : {
            text: '',
            status: 'error',
            note: 'ファイルの形が壊れているため読み取れませんでした。',
            extractor,
          };
    }
  }

  let result: TextExtraction;
  try {
    if (kind === 'pdf') {
      const pdf = await extractPdfText(bytes, {
        maxPages: limits.maxPages,
        maxChars: limits.maxChars,
        timeoutMs: limits.parseTimeoutMs,
        now: deps.now,
      });
      result = {
        text: pdf.text,
        pages: pdf.pages,
        extractedPages: pdf.extractedPages,
        truncated: pdf.truncated,
        extractor,
      };
    } else if (kind === 'html') {
      result = { text: extractHtmlText(bytes), extractor };
    } else if (kind === 'docx') {
      result = { text: await extractDocxText(bytes), extractor };
    } else if (kind === 'xlsx') {
      result = { text: await extractXlsxText(bytes, { maxChars: limits.maxChars }), extractor };
    } else {
      result = { text: decodeText(bytes), extractor };
    }
  } catch (err) {
    if (err instanceof PdfTimeoutError) {
      return {
        text: '',
        status: 'timeout',
        note: '解析に時間がかかりすぎたため打ち切りました。',
        extractor,
      };
    }
    return {
      text: '',
      status: 'error',
      note: '壊れているか、パスワードが掛かっているため読み取れませんでした。',
      extractor,
    };
  }

  if (result.text.trim().length === 0) {
    return {
      ...result,
      status: 'no_text',
      note: '文字を取り出せませんでした（画像だけのファイルかもしれません）。',
    };
  }
  return result;
}

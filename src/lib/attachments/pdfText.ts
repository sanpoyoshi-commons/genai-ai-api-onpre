import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * PDF の文字の取り出し（pdfjs-dist 6.3.289・Apache-2.0）。
 *
 * `getDocument()` と `getTextContent()` だけを使う。描画はしないので canvas は要らない
 * （pdfjs-dist の optional 依存 `@napi-rs/canvas` は `NodeCanvasFactory._createCanvas` からしか
 * require されない＝runtime イメージからは外してよい。Dockerfile の `--omit=optional` を参照）。
 *
 * **`cMapUrl` と `cMapPacked` は日本語 PDF に必須**【事実：2026-09-27 に実測】。定義済み Adobe CMap
 * （`UniJIS-UCS2-H` 等）を使うフォントでは、未指定だと pdf.js が
 * `loadFont - translateFont failed: Ensure that the cMapUrl API parameter is provided.` を warn して
 * **例外を投げずに本文が空文字になる**（=「読めません」と同じ症状に戻る）。
 * `standardFontDataUrl` は必須ではない（`fetchStandardFontData` が例外を握って warn し null を返す）が、
 * 非埋め込みの標準フォントで毎回 warn が出るので渡しておく。`wasmUrl` は JS 実装へ落ちるので渡さない。
 *
 * 時間切れは、ページごとに await を挟み、期限を超えたらそこで打ち切る。
 */

export interface PdfExtractResult {
  text: string;
  /** PDF 全体のページ数。 */
  pages: number;
  /** 実際に読んだページ数。 */
  extractedPages: number;
  /** ページ数・文字数・時間のいずれかで打ち切ったか。 */
  truncated: boolean;
}

export interface PdfExtractOptions {
  maxPages: number;
  maxChars: number;
  timeoutMs: number;
  /** 時計。既定は Date.now。テストが時間切れを決定的に起こすための seam。 */
  now?: () => number;
}

/** pdfjs-dist のパッケージ根（cmaps/ と standard_fonts/ の親）。 */
function pdfjsRoot(): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('pdfjs-dist/package.json'));
}

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjs: Promise<PdfjsModule> | undefined;

/** 初回使用時にだけ読み込む（api の起動を 35MB の import で遅くしない）。 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjs) {
    pdfjs = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjs;
}

/** 期限つきで待つ。超えたら TimeoutError を投げる（呼び出し側が注記へ変える）。 */
async function withDeadline<T>(promise: PromiseLike<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new PdfTimeoutError();
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PdfTimeoutError()), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class PdfTimeoutError extends Error {
  constructor() {
    super('pdf parse timed out');
    this.name = 'PdfTimeoutError';
  }
}

export async function extractPdfText(data: Uint8Array, options: PdfExtractOptions): Promise<PdfExtractResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const { getDocument } = await loadPdfjs();
  const root = pdfjsRoot();

  const task = getDocument({
    // pdf.js は入力の ArrayBuffer を worker へ transfer する。呼び出し側は使い回さないこと。
    data,
    // 日本語 PDF の CID→Unicode に要る。末尾のスラッシュは必須（getFactoryUrlProp が検査する）。
    cMapUrl: path.join(root, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    // XFA（フォーム）は解釈しない。既定も false だが、将来の既定の変更に備えて明示する。
    enableXfa: false,
    // 壊れた PDF でも読める範囲を返す（既定。明示しておく）。
    stopAtErrors: false,
  });

  try {
    const doc = await withDeadline(task.promise, deadline, now);
    const pages = doc.numPages;
    const limit = Math.min(pages, options.maxPages);
    const chunks: string[] = [];
    let chars = 0;
    let extractedPages = 0;
    let truncated = pages > limit;

    for (let n = 1; n <= limit; n++) {
      if (now() >= deadline) {
        truncated = true;
        break;
      }
      const page = await withDeadline(doc.getPage(n), deadline, now);
      const content = await withDeadline(page.getTextContent(), deadline, now);
      const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join('');
      page.cleanup();
      extractedPages += 1;
      chunks.push(pageText);
      chars += pageText.length;
      if (chars >= options.maxChars) {
        truncated = truncated || n < pages;
        break;
      }
    }

    return { text: chunks.join('\n'), pages, extractedPages, truncated };
  } finally {
    // worker（Node では同一プロセスの fake worker）を必ず畳む。
    await task.destroy().catch(() => undefined);
  }
}

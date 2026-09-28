import { createHash } from 'node:crypto';
import { getRequestLogger } from '../../middleware/requestContext.js';
import type { ExtraData, UnrecordedMessage } from '../../types/genaiWeb.js';
import { LruCache } from './cache.js';
import { type AttachmentLimits, loadAttachmentLimits } from './config.js';
import { buildDocumentsBlock, cutChars, type DocumentEntry } from './documents.js';
import { extractDocxText } from './docxText.js';
import { extractHtmlText } from './htmlText.js';
import { formatOfMediaType, isWithinImageLimits, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, sniffImage } from './imageSniff.js';
import { extractXlsxText } from './xlsxText.js';
import { checkZip } from './zipGuard.js';
import { extractPdfText, PdfTimeoutError } from './pdfText.js';
import { decodeText } from './textDecode.js';

/**
 * 添付（extraData）の中身をモデルへ渡せる文字列にする層。
 *
 * 上流（AWS 版）は Bedrock Converse の `document` ブロックに生のバイトを渡し、解釈は Bedrock に任せる。
 * Ollama（OpenAI 互換）にはこの受け口が無いので、ローカルでは api で文字を取り出して本文の前に置く。
 *
 * 本文を取り出すのは pdf・txt・md・csv・html・docx・xlsx。ほかは `status="unsupported"` の注記にする（黙って捨てない）。
 * 取り出しの失敗は例外にせず注記へ変える＝推論そのものは通す。
 */

type Kind = 'pdf' | 'text' | 'html' | 'docx' | 'xlsx' | 'image' | 'unsupported';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv']);
const TEXT_MEDIA_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'application/csv']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/**
 * 画像として扱う名乗り。**渡してよいのは PNG と JPEG だけ**だが、webp・gif も「画像」として拾って
 * `unsupported` の注記にする（黙って落とさないため。実際に渡すかは imageSniff が中身で決める）。
 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function detectKind(name: string, mediaType: string): Kind {
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

/** base64 の実バイト数の見積もり（復号せずに大きさを弾くため）。 */
function estimateBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** 取り出しの結果（text のものだけメモ化の対象）。 */
interface Extraction {
  text: string;
  pages?: number;
  extractedPages?: number;
  truncated?: boolean;
  status?: string;
  note?: string;
  /** status==='image' のときだけ。モデルへ画像ブロックとして渡す実体（メモ化しない）。 */
  image?: ImageAttachment;
}

/** モデルへ画像ブロックとして渡す添付。data は base64 本体（`data:` プレフィクス無し）。 */
export interface ImageAttachment {
  mediaType: string;
  data: string;
}

/** 1メッセージ分の添付。`documents` は空文字なら付けない。 */
export interface MessageAttachments {
  documents: string;
  images: ImageAttachment[];
}

const limits: AttachmentLimits = loadAttachmentLimits();
const cache = new LruCache<Extraction>(limits.cacheEntries);

/** テストから状態を戻すため（プロセス内 LRU の持ち越しを断つ）。 */
export function clearAttachmentCache(): void {
  cache.clear();
}

/** メモ化の件数（テストで上限を確かめるため）。 */
export function attachmentCacheSize(): number {
  return cache.size;
}

export function hasAttachments(messages: UnrecordedMessage[]): boolean {
  return messages.some((m) => (m.extraData?.length ?? 0) > 0);
}

export interface AttachmentDeps {
  /** 時計。既定は Date.now。テストが時間切れを決定的に起こすための seam。 */
  now?: () => number;
  /**
   * 画像ブロックを渡してよい経路か（`LLMAdapter.supportsImages`）。**既定は false＝渡さない。**
   * false のときは画像を `status="unsupported"` の注記にする（黙って落とさない）。
   */
  imagesSupported?: boolean;
}

async function extract(extra: ExtraData, l: AttachmentLimits, deps: AttachmentDeps): Promise<Extraction> {
  if (extra.source.type !== 'base64') {
    return {
      text: '',
      status: 'unsupported',
      note: `この添付（${extra.source.type} 参照）は本文を読み取れませんでした。`,
    };
  }

  const kind = detectKind(extra.name, extra.source.mediaType);
  if (kind === 'unsupported') {
    return { text: '', status: 'unsupported', note: 'この形式は本文を読み取れませんでした。' };
  }

  if (estimateBytes(extra.source.data) > l.maxBytes) {
    return {
      text: '',
      status: 'too_large',
      note: `大きすぎるため解析しませんでした（上限 ${l.maxBytes} バイト）。`,
    };
  }

  // 画像は文字を取り出さない。モデルへ画像ブロックとして渡す（対応している経路のみ）。
  // base64 をそのまま運ぶだけなのでメモ化しない（同じものを二重に抱えない）。
  if (kind === 'image') {
    if (!deps.imagesSupported) {
      return { text: '', status: 'unsupported', note: 'この経路のモデルには画像を渡せません。' };
    }
    // 名乗りが PNG・JPEG 以外（webp・gif）は渡さない。webp は Ollama 同梱の x/image に
    // 既知の DoS があり、gif は Ollama の OpenAI 互換が受け付けない。
    const declared = formatOfMediaType(extra.source.mediaType);
    if (!declared) {
      return {
        text: '',
        status: 'unsupported',
        note: 'この形式の画像は渡せません（PNG と JPEG のみ）。',
      };
    }
    // **中身で判定する。** image/png と名乗った webp でも、受け側は中身で形式を選ぶため。
    const bytes = new Uint8Array(Buffer.from(extra.source.data, 'base64'));
    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      return { text: '', status: 'error', note: '画像として読み取れませんでした。' };
    }
    if (sniffed.format !== declared) {
      return {
        text: '',
        status: 'error',
        note: '名乗っている形式と中身が違うため渡しませんでした。',
      };
    }
    if (!isWithinImageLimits(sniffed)) {
      return {
        text: '',
        status: 'error',
        note: `画像が大きすぎます（各辺 ${MAX_IMAGE_SIDE}px 以下・画素数 ${MAX_IMAGE_PIXELS} 以下）。`,
      };
    }
    return {
      text: '',
      status: 'image',
      note: 'この添付は画像としてモデルへ渡しました。',
      image: { mediaType: sniffed.format === 'png' ? 'image/png' : 'image/jpeg', data: extra.source.data },
    };
  }

  const key = `${kind}:${l.maxPages}:${l.maxChars}:${createHash('sha256').update(extra.source.data).digest('hex')}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const bytes = new Uint8Array(Buffer.from(extra.source.data, 'base64'));
  if (bytes.byteLength > l.maxBytes) {
    return {
      text: '',
      status: 'too_large',
      note: `大きすぎるため解析しませんでした（上限 ${l.maxBytes} バイト）。`,
    };
  }

  // docx・xlsx は zip。解析へ渡す前に、宣言された展開後サイズとエントリ数で弾く（zip 爆弾）。
  if (kind === 'docx' || kind === 'xlsx') {
    const verdict = checkZip(bytes);
    if (!verdict.ok) {
      return verdict.reason === 'too_large'
        ? { text: '', status: 'too_large', note: '展開すると大きすぎるため解析しませんでした。' }
        : { text: '', status: 'error', note: 'ファイルの形が壊れているため読み取れませんでした。' };
    }
  }

  let result: Extraction;
  try {
    if (kind === 'pdf') {
      const pdf = await extractPdfText(bytes, {
        maxPages: l.maxPages,
        maxChars: l.maxChars,
        timeoutMs: l.parseTimeoutMs,
        now: deps.now,
      });
      result = {
        text: pdf.text,
        pages: pdf.pages,
        extractedPages: pdf.extractedPages,
        truncated: pdf.truncated,
      };
    } else if (kind === 'html') {
      result = { text: extractHtmlText(bytes) };
    } else if (kind === 'docx') {
      result = { text: await extractDocxText(bytes) };
    } else if (kind === 'xlsx') {
      result = { text: await extractXlsxText(bytes, { maxChars: l.maxChars }) };
    } else {
      result = { text: decodeText(bytes) };
    }
  } catch (err) {
    if (err instanceof PdfTimeoutError) {
      // 時間切れはその時々で変わるのでメモ化しない（次のターンで通るかもしれない）。
      return { text: '', status: 'timeout', note: '解析に時間がかかりすぎたため打ち切りました。' };
    }
    return {
      text: '',
      status: 'error',
      note: '壊れているか、パスワードが掛かっているため読み取れませんでした。',
    };
  }

  if (result.text.trim().length === 0) {
    result = {
      ...result,
      status: 'no_text',
      note: '文字を取り出せませんでした（画像だけのファイルかもしれません）。',
    };
  }

  cache.set(key, result);
  return result;
}

const BUDGET_EXHAUSTED_NOTE = '文字数の合計の上限に達したため、この添付は渡していません（新しい添付を優先しました）。';
const IMAGE_BUDGET_EXHAUSTED_NOTE =
  '画像の枚数の上限に達したため、この画像は渡していません（新しい画像を優先しました）。';
const fileCountNote = (maxFiles: number) =>
  `文書の件数の上限（${maxFiles} 件）を超えたため、この添付は渡していません。`;

/** 解析せずに「画像として扱う添付か」を見る（base64 を復号しない）。 */
function isImageAttachment(extra: ExtraData): boolean {
  return extra.source.type === 'base64' && detectKind(extra.name, extra.source.mediaType) === 'image';
}

/**
 * 複数メッセージ分の `<documents>` ブロックをまとめて組む。戻りは messages と同じ並び・同じ長さ
 * （添付が無いメッセージは空文字）。
 *
 * `ATTACHMENT_TOTAL_MAX_CHARS` は**1リクエスト（送る会話の全体）の合計**（2026-09-27 の決定）。
 * web は毎ターン過去の添付も再送するため、メッセージごとに合計を数えると履歴の数だけ膨らみ、
 * 文脈長を超えて Ollama に黙って切り詰められる（先頭の注意書きが落ちる）。
 * そこで**新しいメッセージの添付から順に**予算を割り当て、入りきらない古い添付は
 * `status="skipped"` の注記にする（黙って捨てない）。1件の上限（`ATTACHMENT_MAX_CHARS`）は添付1件ごと。
 *
 * **件数の上限は文書と画像で別枠**（2026-09-27 の決定）。`ATTACHMENT_MAX_FILES`（メッセージごと）は
 * **文書だけ**を数え、画像は `ATTACHMENT_MAX_IMAGES`（リクエスト全体・新しい順）だけで数える。
 * web も文書 5 件と画像 3 件を別々に数えるので、合わせて数えると 1 通に 8 件付けたときに
 * 3 件が `skipped` になってしまう。
 */
export async function renderAttachmentsForMessages(
  messages: UnrecordedMessage[],
  l: AttachmentLimits = limits,
  deps: AttachmentDeps = {},
): Promise<MessageAttachments[]> {
  const result: MessageAttachments[] = messages.map(() => ({ documents: '', images: [] }));
  const entriesByIndex = new Map<number, DocumentEntry[]>();
  let budget = l.totalMaxChars;
  // 画像は文字の予算を食わない代わりに、枚数でリクエスト全体を絞る（文脈長と body の両方に効く）。
  let imageBudget = l.maxImages;

  // 新しいメッセージ（末尾）から予算を割り当てる。出力の並びは元のままにする。
  for (let i = messages.length - 1; i >= 0; i--) {
    const extraData = messages[i]?.extraData;
    if (!extraData || extraData.length === 0) {
      continue;
    }

    const entries: DocumentEntry[] = [];
    // 文書の件数はメッセージごとに数える（画像はここでは数えない）。
    let documentCount = 0;
    for (const extra of extraData) {
      if (isImageAttachment(extra)) {
        // 画像の枠が尽きていれば復号も判定もしない（古い画像を毎ターン読み直さない）。
        if (imageBudget <= 0) {
          entries.push({ name: extra.name, status: 'skipped', note: IMAGE_BUDGET_EXHAUSTED_NOTE });
          continue;
        }
      } else {
        documentCount += 1;
        if (documentCount > l.maxFiles) {
          entries.push({ name: extra.name, status: 'skipped', note: fileCountNote(l.maxFiles) });
          continue;
        }
        if (budget <= 0) {
          // 予算が尽きていれば解析もしない（古い添付のために毎ターン解析し直さない）。
          entries.push({ name: extra.name, status: 'skipped', note: BUDGET_EXHAUSTED_NOTE });
          continue;
        }
      }

      const extraction = await extract(extra, l, deps);
      if (extraction.image) {
        // 画像は文字数の予算を使わない（文字が無い）。件数の上限と枚数の上限を使う。
        result[i]?.images.push(extraction.image);
        imageBudget -= 1;
      }
      if (extraction.status) {
        entries.push({ name: extra.name, status: extraction.status, note: extraction.note });
        continue;
      }

      const perFile = cutChars(extraction.text, l.maxChars);
      const withinBudget = cutChars(perFile.text, budget);
      budget -= Array.from(withinBudget.text).length;

      if (withinBudget.text.length === 0) {
        entries.push({ name: extra.name, status: 'skipped', note: BUDGET_EXHAUSTED_NOTE });
        continue;
      }

      entries.push({
        name: extra.name,
        text: withinBudget.text,
        pages: extraction.pages,
        extractedPages: extraction.extractedPages,
        truncated: (extraction.truncated ?? false) || perFile.cut || withinBudget.cut,
      });
    }

    entriesByIndex.set(i, entries);
  }

  if (entriesByIndex.size === 0) {
    return result;
  }

  const all: DocumentEntry[] = [];
  for (const [i, entries] of entriesByIndex) {
    const target = result[i];
    if (target) {
      target.documents = buildDocumentsBlock(entries);
    }
    all.push(...entries);
  }

  getRequestLogger()
    .child({ component: 'api.attachments' })
    .info(
      {
        event: 'attachments_rendered',
        messages: entriesByIndex.size,
        files: all.length,
        images: result.reduce((n, r) => n + r.images.length, 0),
        chars: l.totalMaxChars - budget,
        statuses: all.map((e) => e.status ?? 'ok'),
      },
      'attachments rendered',
    );
  return result;
}

/** 1メッセージ分の `<documents>` ブロックを組む。添付が無ければ空文字。 */
export async function renderAttachments(
  extraData: ExtraData[] | undefined,
  l: AttachmentLimits = limits,
  deps: AttachmentDeps = {},
): Promise<string> {
  if (!extraData || extraData.length === 0) {
    return '';
  }
  const [only] = await renderAttachmentsForMessages([{ role: 'user', content: '', extraData }], l, deps);
  return only?.documents ?? '';
}

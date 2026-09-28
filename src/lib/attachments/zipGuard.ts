import { inflateRawSync } from 'node:zlib';

/**
 * zip の入口検査（docx・xlsx に共通。依存は Node 標準の zlib だけ）。
 *
 * docx も xlsx も中身は zip なので、小さな添付が展開で巨大になる細工（zip 爆弾）を受けうる。
 * **解析に渡す前に、中央ディレクトリを読んだうえで実際に展開して合計を数える**（2026-09-27 の決定）。
 * 宣言だけを信じる検査は、申告を偽った zip に通されてしまうため。
 *
 * 数え方：
 *  1. 中央ディレクトリからエントリ数・圧縮方式・汎用フラグ・圧縮後サイズ・ローカルヘッダの位置を読む。
 *  2. 暗号化（汎用フラグ bit 0）と、0（無圧縮）・8（deflate）以外の方式は解析しない。
 *  3. エントリの領域が連続しているかを見る（中央ディレクトリに載っていない「隠れたエントリ」の検出）。
 *  4. 方式 8 は `zlib.inflateRawSync(data, { maxOutputLength: 残りの予算 })` で展開して実寸を数える。
 *     予算を超えると Node が `ERR_BUFFER_TOO_LARGE` で止めるので、巨大な展開を最後までやらない。
 *     方式 0 は圧縮後サイズがそのまま展開後サイズ。
 *
 * 残る限界：ここで展開した結果と、解析ライブラリ（`jszip`／`unzipper-esm`／`fflate`）が実際に展開する
 * 量が一致する保証は無い。3つとも展開後の大きさに上限を持たない【事実：同梱ソース】ので、
 * 入口の `ATTACHMENT_MAX_BYTES`（5MiB）と1件あたりの解析時間の上限が最後の砦であることは変わらない。
 */

/** 展開後サイズの合計の上限。 */
export const MAX_ZIP_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;
/** エントリ数の上限。 */
export const MAX_ZIP_ENTRIES = 10000;
/**
 * エントリとエントリの間に許す隙間（バイト）。データ記述子（12・16・20・24 バイト）を吸収する。
 * これを超える隙間は「中央ディレクトリに載っていない何かがある」と見なす。
 */
const MAX_ENTRY_GAP = 64;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65535 + 22;
/** ZIP64 では 32bit の枠に収まらない値がこの番兵になる。 */
const ZIP64_SENTINEL = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** 汎用フラグ bit 0＝暗号化。 */
const FLAG_ENCRYPTED = 0x0001;

function le16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function le32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
    (bytes[at + 3] ?? 0) * 0x1000000
  );
}

function findEocd(bytes: Uint8Array): number | undefined {
  const from = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (le32(bytes, i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return undefined;
}

interface CentralEntry {
  /** ローカルヘッダの位置。 */
  offset: number;
  method: number;
  flags: number;
  compressedSize: number;
  /** 中央ディレクトリが申告する展開後サイズ（参考。数えるのは実際の展開）。 */
  declaredUncompressed: number;
}

export interface ZipDeclaration {
  entries: number;
  /** 中央ディレクトリの申告の合計。 */
  totalUncompressed: number;
}

/** 中央ディレクトリを読む。読めなければ undefined。 */
function readCentralDirectory(bytes: Uint8Array): { entries: CentralEntry[]; centralOffset: number } | undefined {
  const eocd = findEocd(bytes);
  if (eocd === undefined) {
    return undefined;
  }
  const count = le16(bytes, eocd + 10);
  const centralOffset = le32(bytes, eocd + 16);
  if (count === 0xffff || centralOffset === ZIP64_SENTINEL || centralOffset >= bytes.length) {
    return undefined;
  }
  if (count > MAX_ZIP_ENTRIES) {
    // 数え始める前に弾く（エントリ数そのものが攻撃面になる）。
    return undefined;
  }

  const entries: CentralEntry[] = [];
  let at = centralOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || le32(bytes, at) !== CENTRAL_SIGNATURE) {
      return undefined;
    }
    const flags = le16(bytes, at + 8);
    const method = le16(bytes, at + 10);
    const compressedSize = le32(bytes, at + 20);
    const declaredUncompressed = le32(bytes, at + 24);
    const offset = le32(bytes, at + 42);
    if (compressedSize === ZIP64_SENTINEL || declaredUncompressed === ZIP64_SENTINEL || offset === ZIP64_SENTINEL) {
      return undefined;
    }
    entries.push({ offset, method, flags, compressedSize, declaredUncompressed });
    at += 46 + le16(bytes, at + 28) + le16(bytes, at + 30) + le16(bytes, at + 32);
  }
  return { entries, centralOffset };
}

/**
 * 中央ディレクトリの申告（エントリ数と展開後サイズの合計）を返す。読めなければ undefined。
 * **判定には使わない**（数えるのは `checkZip` の実展開）。記録と検算のために公開する。
 */
export function inspectZip(bytes: Uint8Array): ZipDeclaration | undefined {
  const central = readCentralDirectory(bytes);
  if (!central) {
    return undefined;
  }
  return {
    entries: central.entries.length,
    totalUncompressed: central.entries.reduce((sum, e) => sum + e.declaredUncompressed, 0),
  };
}

export type ZipVerdict = { ok: true; uncompressed: number } | { ok: false; reason: 'unreadable' | 'too_large' };

/**
 * 解析してよい zip か。**実際に展開して数える。**
 * `too_large` は上限超え、`unreadable` はそれ以外（壊れている・暗号化・未対応の圧縮方式・隠れたエントリ）。
 */
export function checkZip(bytes: Uint8Array): ZipVerdict {
  const central = readCentralDirectory(bytes);
  if (!central) {
    return { ok: false, reason: 'unreadable' };
  }

  // 位置の順に並べて、領域の連続を見る（中央ディレクトリに載っていないエントリの検出）。
  const ordered = [...central.entries].sort((a, b) => a.offset - b.offset);
  let expected = ordered[0]?.offset ?? central.centralOffset;
  let remaining = MAX_ZIP_TOTAL_UNCOMPRESSED;
  let total = 0;

  for (const entry of ordered) {
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      return { ok: false, reason: 'unreadable' };
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      return { ok: false, reason: 'unreadable' };
    }
    if (entry.offset < expected - MAX_ENTRY_GAP || entry.offset > expected + MAX_ENTRY_GAP) {
      // 前のエントリの終わりから離れすぎている＝間に何かある。
      return { ok: false, reason: 'unreadable' };
    }
    if (entry.offset + 30 > bytes.length || le32(bytes, entry.offset) !== LOCAL_SIGNATURE) {
      return { ok: false, reason: 'unreadable' };
    }

    // データの位置はローカルヘッダの名前長・拡張長から求める（中央ディレクトリの値とは別物）。
    const dataStart = entry.offset + 30 + le16(bytes, entry.offset + 26) + le16(bytes, entry.offset + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) {
      return { ok: false, reason: 'unreadable' };
    }

    if (entry.method === METHOD_STORED) {
      total += entry.compressedSize;
    } else {
      if (remaining <= 0) {
        return { ok: false, reason: 'too_large' };
      }
      try {
        // 予算を超えた時点で Node が ERR_BUFFER_TOO_LARGE を投げる（最後まで展開しない）。
        const out = inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: remaining });
        total += out.byteLength;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'unreadable' };
      }
    }

    if (total > MAX_ZIP_TOTAL_UNCOMPRESSED) {
      return { ok: false, reason: 'too_large' };
    }
    remaining = MAX_ZIP_TOTAL_UNCOMPRESSED - total;
    // 次のエントリはここから始まるはず（データ記述子の分は MAX_ENTRY_GAP で吸収する）。
    expected = dataEnd;
  }

  // 最後のエントリの終わりから中央ディレクトリまでに隙間があれば、そこにも何かある。
  if (central.centralOffset > expected + MAX_ENTRY_GAP) {
    return { ok: false, reason: 'unreadable' };
  }

  return { ok: true, uncompressed: total };
}

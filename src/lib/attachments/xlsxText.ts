import readXlsxFile from 'read-excel-file/node';

/**
 * xlsx から表の文字を取り出す（read-excel-file 9.3.10・MIT）。
 *
 * シートごとに `[シート: 名前]` の見出しを置き、各行をタブ区切りで並べる。
 * **数式ではなく値を取る**（read-excel-file はシートに保存された計算済みの値を読み、式を評価しない）。
 *
 * Node の入口（`read-excel-file/node`）は `worker-f/node` を import するが、
 * 実際にワーカーは起こさない（`parseSpreadsheetContentsInWorker` は受け取った関数を使わず、
 * 同じスレッドで解析する。JSDoc にも "Not used" とある）。`node:worker_threads` が読み込まれるだけ。
 *
 * 上限の切りは呼び出し側（`ATTACHMENT_MAX_CHARS`）と同じだが、巨大なシートで文字列を作り切らないよう
 * ここでも累積で打ち切る。
 */

export interface XlsxExtractOptions {
  /** これを超えたら組み立てを止める（呼び出し側がさらに正確に切る）。 */
  maxChars: number;
}

/**
 * Excel の日付の起点（通し番号 0 の日）。read-excel-file は 1904 方式のブックも
 * 1900 方式へ直してから `Date` にするので、時刻だけのセルはこのどちらかの日付になる。
 */
const EXCEL_EPOCH_1900 = Date.UTC(1899, 11, 30);
const EXCEL_EPOCH_1904 = Date.UTC(1904, 0, 1);

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 日付・時刻のセルを文字へ。
 *
 * Excel は日付も時刻も「起点からの日数」という1つの数で持ち、時刻だけのセル（例 21:21）は
 * 起点の日の時刻になる。**日付の部分だけを出すと時刻が落ちて「1899-12-30」になる**ため、
 * 中身に応じて出し分ける：
 *  - 時刻が 0 → `YYYY-MM-DD`
 *  - 日付が起点（1899-12-30 か 1904-01-01）→ `HH:MM`（秒があれば `HH:MM:SS`）
 *  - それ以外 → `YYYY-MM-DD HH:MM`（秒があれば `:SS`）
 *
 * 時刻は1日の割合（21:21＝0.8895833…）なので、`Date` に直すと 21:20:59.999 のような誤差が出る。
 * **秒の単位へ丸めてから**書き出す。取り出しは UTC の getter で行う（コンテナの TZ に左右されない）。
 */
function formatDateCell(value: Date): string {
  const rounded = new Date(Math.round(value.getTime() / 1000) * 1000);
  const year = rounded.getUTCFullYear();
  const month = rounded.getUTCMonth();
  const day = rounded.getUTCDate();
  const hours = rounded.getUTCHours();
  const minutes = rounded.getUTCMinutes();
  const seconds = rounded.getUTCSeconds();

  const datePart = `${year}-${pad(month + 1)}-${pad(day)}`;
  if (hours === 0 && minutes === 0 && seconds === 0) {
    return datePart;
  }

  const timePart = seconds === 0 ? `${pad(hours)}:${pad(minutes)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  const dayStart = Date.UTC(year, month, day);
  if (dayStart === EXCEL_EPOCH_1900 || dayStart === EXCEL_EPOCH_1904) {
    // 時刻だけのセル。日付は Excel の起点でしかないので出さない。
    return timePart;
  }
  return `${datePart} ${timePart}`;
}

/** セルの値を文字へ。 */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return formatDateCell(value);
  }
  return String(value);
}

export async function extractXlsxText(bytes: Uint8Array, options: XlsxExtractOptions): Promise<string> {
  // 9.x は1回の呼び出しで全シート（名前＋行）を返す。zip の展開も1回で済む。
  const sheets = await readXlsxFile(Buffer.from(bytes));

  const parts: string[] = [];
  let chars = 0;
  for (const { sheet, data } of sheets) {
    if (chars >= options.maxChars) {
      break;
    }
    const head = `[シート: ${sheet}]`;
    parts.push(head);
    chars += head.length + 1;
    for (const row of data) {
      if (chars >= options.maxChars) {
        break;
      }
      const line = row.map(cellToText).join('\t').trimEnd();
      parts.push(line);
      chars += line.length + 1;
    }
  }

  return parts.join('\n').trim();
}

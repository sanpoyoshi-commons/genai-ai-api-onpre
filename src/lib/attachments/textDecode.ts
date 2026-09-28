/**
 * テキスト系添付（txt・md・csv）の文字コードの解釈。**依存は足さない**。
 *
 * 手順：BOM を見る → `TextDecoder('utf-8', { fatal: true })` → 失敗したら shift_jis・euc-jp の順。
 * どれも通らなければ utf-8 の非 fatal（置換文字混じり）で返す。文字を出さずに捨てるよりは、
 * 化けていても中身を渡してモデルに判断させる方がよい。
 *
 * 旧エンコーディング（shift_jis・euc-jp）の復号は Node の full-icu に依存する。small-icu の
 * ビルドでは `new TextDecoder('shift_jis')` が RangeError を投げるため、その場合は黙って次へ進む。
 */

const LEGACY_ENCODINGS = ['shift_jis', 'euc-jp'] as const;

/** BOM 付きの先頭バイト列と、対応する encoding／BOM の長さ。 */
const BOMS: { bytes: number[]; encoding: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((b, i) => bytes[i] === b);
}

/** fatal で復号し、失敗（不正バイト列・未対応 encoding）は undefined を返す。 */
function tryDecode(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function decodeText(bytes: Uint8Array): string {
  for (const bom of BOMS) {
    if (startsWith(bytes, bom.bytes)) {
      // ignoreBOM: false なので TextDecoder が BOM を取り除く。utf-16 は BOM が無いと向きが決まらない。
      const decoded = tryDecode(bytes, bom.encoding);
      if (decoded !== undefined) {
        return decoded;
      }
    }
  }

  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== undefined) {
    return utf8;
  }

  for (const encoding of LEGACY_ENCODINGS) {
    const decoded = tryDecode(bytes, encoding);
    if (decoded !== undefined) {
      return decoded;
    }
  }

  // 最後の手段。置換文字（U+FFFD）が混ざるが、読める部分は渡す。
  return new TextDecoder('utf-8').decode(bytes);
}

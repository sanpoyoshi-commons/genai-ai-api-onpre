/**
 * バイトフォールバック表記（`<0xE3><0x80><0x80>` のような文字列）を本来の文字へ復号する。
 *
 * SentencePiece 系の語彙（gemma 等）は専用トークンを持たない文字を**バイト単位のトークン**で表し、
 * その語彙上の表記が `<0xE3>` のような文字列になっている。このピース文字列が実バイトへ復号されない
 * まま生成テキストに混ざることがあり、日本語では全角スペース（U+3000＝`E3 80 80`）で顕著に出る
 * （法令本文は項番号の後や字下げに全角スペースを多用するため目立つ・gemma4:e2b で実測）。
 *
 * 復号はモデル出力の受け口（LLM 抽象化レイヤー）で一律に行う。特定機能ではなく全機能（チャット・
 * 翻訳・ダイアグラム・法令レポート）に効かせるため。**復号できないバイト列は元の表記のまま残す**
 * （壊れた UTF-8 を作らない安全側＝本来 `<0x41>` のような文字列を含む正当なテキストも壊さない）。
 */

/** 連続したバイトトークン表記（1 文字は複数バイト＝連続して現れる）。 */
const BYTE_TOKEN_RUN = /(?:<0x[0-9A-Fa-f]{2}>)+/g;

/** 1 個のバイトトークン表記（実バイト取り出し用）。 */
const BYTE_TOKEN = /<0x([0-9A-Fa-f]{2})>/g;

/**
 * ストリームで末尾に保留すべき領域。
 * ①完結したバイトトークン列（次チャンクで続きが来て 1 文字になるかもしれない）
 * ②途中まで届いたバイトトークン（`<`／`<0`／`<0x`／`<0xE`／`<0xE3`＝閉じ `>` 待ち）
 */
const TRAILING_HOLD = /(?:<0x[0-9A-Fa-f]{2}>)*(?:<(?:0(?:x[0-9A-Fa-f]{0,2})?)?)?$/;

/** 保留の上限。これを超えたら復号を諦めて出す（異常出力で無限にバッファしないための保険）。 */
const MAX_HOLD_CHARS = 64;

const decoder = new TextDecoder('utf-8', { fatal: false });

/** UTF-8 の先頭バイトが示す符号長（継続バイト単独・不正な先頭バイトは 0）。 */
function utf8SequenceLength(byte: number): number {
  if (byte < 0x80) {
    return 1;
  }
  if (byte >= 0xc2 && byte <= 0xdf) {
    return 2;
  }
  if (byte >= 0xe0 && byte <= 0xef) {
    return 3;
  }
  if (byte >= 0xf0 && byte <= 0xf4) {
    return 4;
  }
  return 0;
}

/**
 * 連続したバイトトークン列を復号する。**バイト単位**で見て、有効な UTF-8 として閉じる分だけ文字に戻し、
 * 閉じないバイト（列の途中で切れた・そもそも不正）はそのトークン表記のまま残す。
 * 列まるごとで判定すると、末尾 1 バイトが欠けただけで手前の正常な文字まで戻せなくなるため。
 */
function decodeRun(run: string): string {
  const tokens = [...run.matchAll(BYTE_TOKEN)];
  const bytes = tokens.map((m) => Number.parseInt(m[1]!, 16));
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const length = utf8SequenceLength(bytes[i]!);
    if (length > 0 && i + length <= bytes.length) {
      const decoded = decoder.decode(Uint8Array.from(bytes.slice(i, i + length)));
      if (!decoded.includes('�')) {
        out += decoded;
        i += length;
        continue;
      }
    }
    out += tokens[i]![0]; // 復号できないバイトは元の表記を保つ（壊さない安全側）。
    i += 1;
  }
  return out;
}

/** バイトトークン表記を含む文字列を復号する（含まなければ入力をそのまま返す）。 */
export function decodeByteFallback(text: string): string {
  if (!text || !text.includes('<0x')) {
    return text;
  }
  return text.replace(BYTE_TOKEN_RUN, decodeRun);
}

/**
 * ストリーム用の逐次復号器。1 文字分のバイトトークン列がチャンク境界で分断されても復号できるよう、
 * 末尾の未確定部分だけを保留して次チャンクと結合する。`flush` で保留分を必ず吐き出す。
 */
export function createByteFallbackDecoder(): {
  push: (chunk: string) => string;
  flush: () => string;
} {
  let held = '';
  return {
    push(chunk: string): string {
      const buffer = held + chunk;
      if (buffer.length > MAX_HOLD_CHARS && !buffer.includes('<0x')) {
        // 保留候補が無い長文はそのまま流す（大半のチャンクはここを通る）。
        held = '';
        return buffer;
      }
      const match = TRAILING_HOLD.exec(buffer);
      let holdFrom = match ? match.index : buffer.length;
      if (buffer.length - holdFrom > MAX_HOLD_CHARS) {
        holdFrom = buffer.length; // 保留が伸びすぎ＝諦めて出す。
      }
      held = buffer.slice(holdFrom);
      return decodeByteFallback(buffer.slice(0, holdFrom));
    },
    flush(): string {
      const rest = decodeByteFallback(held);
      held = '';
      return rest;
    },
  };
}

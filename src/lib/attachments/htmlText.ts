import { type HTMLElement, parse } from 'node-html-parser';
import { decodeText } from './textDecode.js';

/**
 * HTML から本文の文字を取り出す（node-html-parser 9.0.4・MIT）。
 *
 * `<script>`・`<style>`・`<noscript>` の中身は**二重に落とす**：解析時に blockTextElements で
 * 中身を捨て、さらに要素ごと取り除く。スクリプトの中身がモデルへ渡ると、
 * 資料のふりをした指示の置き場になるため（LLM01）。
 * 文字コードは textDecode に任せる（HTML の meta charset は見ない。UTF-8 でない HTML は
 * BOM か fatal 判定で拾う）。
 *
 * `<pre>` は改行と字下げを保つ。`structuredText` はブロックごとに連続する空白（改行を含む）を
 * 空白 1 つにまとめるので、そのまま通すとコードが 1 行に潰れる。そこで整形の前に各 `<pre>` を
 * 目印へ置き換え、整形が終わってから中身へ戻す（`PRE_MARKER_SEED` 以下）。
 */

const DROP_SELECTORS = ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed'];

/**
 * 解析時に中身を捨てる要素。node-html-parser 9.0.4 では値の意味が 3 通りある。
 * - `false`＝中身を解析せず**捨てる**。
 * - `true`＝中身を解析せず**生の文字として残す**（タグや属性がそのまま本文に混じる）。
 * - キーに書かない＝普通に解析する（子要素になる）。
 *
 * `<pre>` をここに書かないのはどちらの値も使えないため。`true` にすると色付けしたコードの
 * `<span>` が文字として本文に残り、`false` にするとコードごと消える。普通に解析させた上で、
 * 下の目印の仕組みで改行と字下げを保つ。
 */
const BLOCK_TEXT_ELEMENTS = { script: false, noscript: false, style: false };

/**
 * `<pre>` を差し戻すための目印の素。本文に同じ文字列が来ても取り違えないよう、実際に使う素は
 * 「元の HTML にも文書の文字にも現れない」ことを確かめてから決める（`uniqueMarkerSeed`）。
 *
 * `tests/lib/attachments/htmlText.test.ts` が本文に目印を混ぜる試験のためこの値を写し持っている。
 * ここを変えるときはテスト側も合わせる。
 */
export const PRE_MARKER_SEED = '\u241fpre\u241f';

/** 本文に現れない目印の素を作る。現れたら区切りの記号を足して伸ばす。 */
function uniqueMarkerSeed(...haystacks: string[]): string {
  let seed = PRE_MARKER_SEED;
  while (haystacks.some((haystack) => haystack.includes(seed))) {
    seed += '\u241f';
  }
  return seed;
}

const markerFor = (seed: string, index: number) => `${seed}${index}${seed}`;

/** この `<pre>` が別の `<pre>` の中にあるか（外側だけを扱うための判定）。 */
function hasPreAncestor(element: HTMLElement): boolean {
  const parent = element.parentNode;
  return parent !== null && parent.closest('pre') !== null;
}

/**
 * `<pre>` の中身。改行と字下げはそのままにし、実体参照は文字へ戻す（`.text`）。
 *
 * HTML の規定どおり開始タグ直後の改行 1 つは中身に数えない。閉じタグの前の余白も中身ではなく
 * 書き手の字下げなので落とす。コードの行には**行ごとの trim も空行の圧縮もかけない**。
 */
function preformattedText(element: HTMLElement): string {
  return element.text.replace(/\r\n/g, '\n').replace(/^\n/, '').replace(/\s+$/, '');
}

/** 整形のあとで、目印を `<pre>` の中身へ戻す。中身には整形をかけない。 */
function restorePreformatted(text: string, seed: string, blocks: string[]): string {
  if (blocks.length === 0) {
    return text;
  }

  const byMarker = new Map(blocks.map((block, index) => [markerFor(seed, index), block]));
  const lines: string[] = [];

  for (const line of text.split('\n')) {
    // `<pre>` はブロック要素なので、目印は普通この形（1 行がちょうど目印）で現れる。
    const block = byMarker.get(line);
    if (block !== undefined) {
      // 中身が空の `<pre>` は行ごと落とす（空行を作らないため）。
      if (block !== '') {
        lines.push(block);
      }
      continue;
    }
    if (!line.includes(seed)) {
      lines.push(line);
      continue;
    }
    // 目印が行の中に混じった形。
    let replaced = line;
    for (const [marker, inline] of byMarker) {
      replaced = replaced.split(marker).join(inline);
    }
    lines.push(replaced);
  }

  return lines.join('\n');
}

export function extractHtmlText(bytes: Uint8Array): string {
  // node-html-parser は doctype を地の文として残すので、解析の前に落とす。
  const html = decodeText(bytes).replace(/^\s*<!doctype[^>]*>/i, '');

  const root = parse(html, { blockTextElements: BLOCK_TEXT_ELEMENTS });

  for (const selector of DROP_SELECTORS) {
    for (const element of root.querySelectorAll(selector)) {
      element.remove();
    }
  }

  // 落とすものを落としたあとで `<pre>` を目印へ置き換える。`<pre>` の中の `<script>` は
  // この時点で消えているので、目印に取る中身には入らない。
  const seed = uniqueMarkerSeed(html, root.text);
  const preformatted: string[] = [];
  for (const element of root.querySelectorAll('pre')) {
    if (hasPreAncestor(element)) {
      // 入れ子は外側だけ。内側の中身は外側の `.text` に入っている。
      continue;
    }
    const index = preformatted.length;
    preformatted.push(preformattedText(element));
    element.set_content(markerFor(seed, index));
  }

  // structuredText はブロック要素の境界で改行を入れる（textContent は詰めてしまう）。
  // 行ごとの余白を落とし、空行の連なりを1つにまとめる。
  const text = root.structuredText
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return restorePreformatted(text, seed, preformatted);
}

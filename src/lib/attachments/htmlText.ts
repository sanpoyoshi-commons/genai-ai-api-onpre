import { parse } from 'node-html-parser';
import { decodeText } from './textDecode.js';

/**
 * HTML から本文の文字を取り出す（node-html-parser 9.0.4・MIT）。
 *
 * `<script>`・`<style>`・`<noscript>` の中身は**二重に落とす**：解析時に blockTextElements で
 * テキストとして拾わせず、さらに要素ごと取り除く。スクリプトの中身がモデルへ渡ると、
 * 資料のふりをした指示の置き場になるため（LLM01）。
 * 文字コードは textDecode に任せる（HTML の meta charset は見ない。UTF-8 でない HTML は
 * BOM か fatal 判定で拾う）。
 */

const DROP_SELECTORS = ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed'];

export function extractHtmlText(bytes: Uint8Array): string {
  // node-html-parser は doctype を地の文として残すので、解析の前に落とす。
  const html = decodeText(bytes).replace(/^\s*<!doctype[^>]*>/i, '');

  const root = parse(html, {
    // これらの要素の中身をテキストとして保持しない。
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  });

  for (const selector of DROP_SELECTORS) {
    for (const element of root.querySelectorAll(selector)) {
      element.remove();
    }
  }

  // structuredText はブロック要素の境界で改行を入れる（textContent は詰めてしまう）。
  // 行ごとの余白を落とし、空行の連なりを1つにまとめる。
  return root.structuredText
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

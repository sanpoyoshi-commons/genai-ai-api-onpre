import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatOfMediaType,
  isWithinImageLimits,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  sniffImage,
} from '../../../src/lib/attachments/imageSniff.js';

/** PNG の先頭（magic ＋ IHDR）だけを組む。 */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8); // チャンク長
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** JPEG の SOI → APP0 → SOF0 → EOI だけを組む。 */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    ...new Array(9).fill(0),
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

const webp = () =>
  new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const gif = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);

test('sniffImage: PNG の幅と高さを読む', () => {
  assert.deepEqual(sniffImage(png(100, 50)), { format: 'png', width: 100, height: 50 });
});

test('sniffImage: JPEG の幅と高さを読む（SOF を探す）', () => {
  assert.deepEqual(sniffImage(jpeg(640, 480)), { format: 'jpeg', width: 640, height: 480 });
});

test('sniffImage: webp は渡さない（Ollama 同梱の x/image に既知の DoS がある）', () => {
  assert.equal(sniffImage(webp()), undefined);
});

test('sniffImage: gif は渡さない（Ollama の OpenAI 互換が受け付けない）', () => {
  assert.equal(sniffImage(gif()), undefined);
});

test('sniffImage: 途中で切れた PNG は読めない', () => {
  assert.equal(sniffImage(png(10, 10).slice(0, 18)), undefined);
});

test('sniffImage: PNG の magic だが IHDR でないものは読めない', () => {
  const bytes = png(10, 10);
  bytes.set([0x66, 0x66, 0x66, 0x66], 12);
  assert.equal(sniffImage(bytes), undefined);
});

test('sniffImage: 幅か高さが 0 のものは読めない', () => {
  assert.equal(sniffImage(png(0, 10)), undefined);
  assert.equal(sniffImage(jpeg(10, 0)), undefined);
});

test('sniffImage: SOF の無い JPEG（走査が先に来る）は読めない', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  assert.equal(sniffImage(bytes), undefined);
});

test('sniffImage: 空・短すぎるものは読めない', () => {
  assert.equal(sniffImage(new Uint8Array()), undefined);
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50])), undefined);
});

test('isWithinImageLimits: 上限ちょうどは通る', () => {
  assert.equal(isWithinImageLimits({ format: 'png', width: MAX_IMAGE_SIDE, height: 2500 }), true);
  assert.equal(MAX_IMAGE_SIDE * 2500, MAX_IMAGE_PIXELS, '定数の関係が変わったら気づけるようにしておく');
});

test('isWithinImageLimits: 辺が上限を超えたら弾く', () => {
  assert.equal(isWithinImageLimits({ format: 'png', width: MAX_IMAGE_SIDE + 1, height: 1 }), false);
  assert.equal(isWithinImageLimits({ format: 'jpeg', width: 1, height: MAX_IMAGE_SIDE + 1 }), false);
});

test('isWithinImageLimits: 画素数が上限を超えたら弾く（各辺は上限内でも）', () => {
  assert.equal(isWithinImageLimits({ format: 'png', width: 6000, height: 5000 }), false);
});

test('formatOfMediaType: PNG と JPEG だけを受ける', () => {
  assert.equal(formatOfMediaType('image/png'), 'png');
  assert.equal(formatOfMediaType('image/jpeg'), 'jpeg');
  assert.equal(formatOfMediaType('image/jpg'), 'jpeg');
  assert.equal(formatOfMediaType('IMAGE/PNG; charset=binary'), 'png');
  assert.equal(formatOfMediaType('image/webp'), undefined);
  assert.equal(formatOfMediaType('image/gif'), undefined);
  assert.equal(formatOfMediaType(''), undefined);
});

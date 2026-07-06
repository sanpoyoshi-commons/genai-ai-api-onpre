import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isImageError } from '../../src/image/errors.js';
import { mapToImageGenRequest } from '../../src/image/paramMapper.js';

const txt = (text: string, weight = 1) => ({ text, weight });

test('txt2img: 単一プロンプトを正規化する', () => {
  const r = mapToImageGenRequest('sd15', {
    textPrompt: [txt('a cat')],
    cfgScale: 7,
    seed: 42,
    step: 20,
    width: 512,
    height: 768,
  });
  assert.equal(r.mode, 'txt2img');
  assert.equal(r.model, 'sd15');
  assert.equal(r.prompt, 'a cat');
  assert.equal(r.negativePrompt, undefined);
  assert.equal(r.cfgScale, 7);
  assert.equal(r.seed, 42);
  assert.equal(r.steps, 20);
  assert.equal(r.width, 512);
  assert.equal(r.height, 768);
  assert.equal(r.initImage, undefined);
});

test('プロンプト重み: 負重みは negative、非1は注意記法', () => {
  const r = mapToImageGenRequest('sd15', {
    textPrompt: [txt('a cat', 1), txt('detailed', 1.3), txt('blurry', -1), txt('ugly', -0.5)],
  });
  assert.equal(r.prompt, 'a cat, (detailed:1.3)');
  assert.equal(r.negativePrompt, 'blurry, (ugly:0.5)');
});

test('img2img: initImage のみで img2img', () => {
  const r = mapToImageGenRequest('sd15', {
    textPrompt: [txt('a cat')],
    initImage: 'INITB64',
    imageStrength: 0.6,
  });
  assert.equal(r.mode, 'img2img');
  assert.equal(r.initImage, 'INITB64');
  assert.equal(r.strength, 0.6);
});

test('inpaint: initImage + maskImage で inpaint', () => {
  const r = mapToImageGenRequest('sd15', {
    textPrompt: [txt('a cat')],
    initImage: 'INITB64',
    maskImage: 'MASKB64',
  });
  assert.equal(r.mode, 'inpaint');
  assert.equal(r.initImage, 'INITB64');
  assert.equal(r.maskImage, 'MASKB64');
});

test('controlnet: controlMode + initImage で controlnet（controlImage=initImage）', () => {
  const r = mapToImageGenRequest('sd15', {
    textPrompt: [txt('a cat')],
    initImage: 'COND',
    controlMode: 'CANNY_EDGE',
    controlStrength: 0.8,
  });
  assert.equal(r.mode, 'controlnet');
  assert.equal(r.controlImage, 'COND');
  assert.equal(r.controlStrength, 0.8);
});

test('inpaint で initImage 欠落は INVALID_REQUEST', () => {
  assert.throws(
    () => mapToImageGenRequest('sd15', { textPrompt: [txt('a cat')], maskImage: 'MASKB64' }),
    (e) => isImageError(e) && e.code === 'INVALID_REQUEST',
  );
});

for (const taskType of ['OUTPAINTING', 'COLOR_GUIDED_GENERATION', 'BACKGROUND_REMOVAL'] as const) {
  test(`未対応 taskType '${taskType}' は MODE_NOT_SUPPORTED`, () => {
    assert.throws(
      () => mapToImageGenRequest('sd15', { taskType, textPrompt: [txt('a cat')] }),
      (e) => isImageError(e) && e.code === 'MODE_NOT_SUPPORTED',
    );
  });
}

test('maskPrompt 指定は MODE_NOT_SUPPORTED', () => {
  assert.throws(
    () => mapToImageGenRequest('sd15', { textPrompt: [txt('a cat')], maskPrompt: 'the dog' }),
    (e) => isImageError(e) && e.code === 'MODE_NOT_SUPPORTED',
  );
});

test('colors 指定（color-guided）は MODE_NOT_SUPPORTED', () => {
  assert.throws(
    () => mapToImageGenRequest('sd15', { textPrompt: [txt('a cat')], colors: ['#ff0000'] }),
    (e) => isImageError(e) && e.code === 'MODE_NOT_SUPPORTED',
  );
});

test('textPrompt 空は INVALID_REQUEST', () => {
  assert.throws(
    () => mapToImageGenRequest('sd15', { textPrompt: [] }),
    (e) => isImageError(e) && e.code === 'INVALID_REQUEST',
  );
});

test('正のプロンプトが無い（全て負重み）は INVALID_REQUEST', () => {
  assert.throws(
    () => mapToImageGenRequest('sd15', { textPrompt: [txt('blurry', -1)] }),
    (e) => isImageError(e) && e.code === 'INVALID_REQUEST',
  );
});

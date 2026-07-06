import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveEnabledUseCases } from '../../src/lib/config/enabledUseCases.js';

// resolveEnabledUseCases は env を引数で受けるため process.env を汚さずに検証できる。
const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

test('既定（env なし）＝チャットのみ on、他は off', () => {
  const e = resolveEnabledUseCases(env());
  assert.deepEqual(e, {
    chat: true,
    generate: false,
    translate: false,
    diagram: false,
    image: false,
    transcribe: false,
    rag: false,
    apps: false,
    codeInterpreter: false,
  });
});

test('COMPOSE_PROFILES=llm で generate/translate/diagram が on（image/transcribe/rag は off）', () => {
  const e = resolveEnabledUseCases(env({ COMPOSE_PROFILES: 'llm' }));
  assert.equal(e.chat, true);
  assert.equal(e.generate, true);
  assert.equal(e.translate, true);
  assert.equal(e.diagram, true);
  assert.equal(e.image, false);
  assert.equal(e.transcribe, false);
  assert.equal(e.rag, false);
});

test('COMPOSE_PROFILES=llm,embedding で rag が on', () => {
  const e = resolveEnabledUseCases(env({ COMPOSE_PROFILES: 'llm,embedding' }));
  assert.equal(e.rag, true);
  assert.equal(e.generate, true);
  assert.equal(e.image, false);
});

test('フル profile で全機能 on', () => {
  const e = resolveEnabledUseCases(
    env({ COMPOSE_PROFILES: 'llm,embedding,rerank,image,transcribe,queue,sandbox' }),
  );
  assert.deepEqual(e, {
    chat: true,
    generate: true,
    translate: true,
    diagram: true,
    image: true,
    transcribe: true,
    rag: true,
    apps: true,
    codeInterpreter: true,
  });
});

test('COMPOSE_PROFILES=queue で apps（ExApp 非同期実行）が on', () => {
  const e = resolveEnabledUseCases(env({ COMPOSE_PROFILES: 'llm,queue' }));
  assert.equal(e.apps, true);
  assert.equal(e.rag, false);
});

test('queue 無しなら apps は off（既定 llm）', () => {
  const e = resolveEnabledUseCases(env({ COMPOSE_PROFILES: 'llm' }));
  assert.equal(e.apps, false);
});

test('部分一致で誤点灯しない（llmx は llm 扱いしない）', () => {
  const e = resolveEnabledUseCases(env({ COMPOSE_PROFILES: 'llmx' }));
  assert.equal(e.generate, false);
});

test('ENABLED_USE_CASES（明示）が COMPOSE_PROFILES より優先（方式 c）', () => {
  const e = resolveEnabledUseCases(
    env({
      COMPOSE_PROFILES: 'llm,embedding,image,transcribe',
      ENABLED_USE_CASES: '{"chat":true,"translate":true}',
    }),
  );
  // 明示で指定したキーのみ on、未指定は off（chat は既定 on）。profile 算出は無視される。
  assert.equal(e.chat, true);
  assert.equal(e.translate, true);
  assert.equal(e.generate, false);
  assert.equal(e.image, false);
  assert.equal(e.transcribe, false);
  assert.equal(e.rag, false);
});

test('不正な ENABLED_USE_CASES JSON は無視して profile 算出へフォールバック', () => {
  const e = resolveEnabledUseCases(
    env({ COMPOSE_PROFILES: 'llm', ENABLED_USE_CASES: '{not json' }),
  );
  assert.equal(e.generate, true);
  assert.equal(e.image, false);
});

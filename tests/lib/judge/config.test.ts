import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadJudgeConfig } from '../../../src/lib/judge/config.js';

test('既定値（env なし）', () => {
  const config = loadJudgeConfig({});
  assert.equal(config.baseUrl, 'http://ollama:11434');
  assert.equal(config.defaultModel, undefined);
  assert.deepEqual(config.allowedModels, []);
  assert.equal(config.contextLength, 8192);
  assert.equal(config.maxStateBytes, 8192);
  assert.equal(config.attemptTimeoutMs, 300000);
  assert.equal(config.requestBudgetMs, 600000);
  assert.equal(config.maxRetryWaitMs, 60000);
});

test('既定モデルは JUDGE_DEFAULT_MODEL → OLLAMA_DEFAULT_CHAT_MODEL の順に解決する', () => {
  assert.equal(loadJudgeConfig({ OLLAMA_DEFAULT_CHAT_MODEL: 'gemma4:e2b' }).defaultModel, 'gemma4:e2b');
  assert.equal(
    loadJudgeConfig({ JUDGE_DEFAULT_MODEL: 'a', OLLAMA_DEFAULT_CHAT_MODEL: 'b' }).defaultModel,
    'a',
  );
});

test('許可リスト未設定なら既定モデルのみ許可（素通しにはしない）', () => {
  assert.deepEqual(loadJudgeConfig({ JUDGE_DEFAULT_MODEL: 'a' }).allowedModels, ['a']);
  assert.deepEqual(
    loadJudgeConfig({ JUDGE_DEFAULT_MODEL: 'a', JUDGE_ALLOWED_MODELS: 'a, b ,' }).allowedModels,
    ['a', 'b'],
  );
});

test('コンテキスト長は JUDGE_CONTEXT_LENGTH → OLLAMA_CONTEXT_LENGTH → 8192 の順（実設定に揃える）', () => {
  assert.equal(loadJudgeConfig({ OLLAMA_CONTEXT_LENGTH: '4096' }).contextLength, 4096);
  assert.equal(
    loadJudgeConfig({ JUDGE_CONTEXT_LENGTH: '2048', OLLAMA_CONTEXT_LENGTH: '8192' }).contextLength,
    2048,
  );
});

test('ベース URL は末尾スラッシュを落とす（/api/chat の二重スラッシュ回避）', () => {
  assert.equal(loadJudgeConfig({ JUDGE_OLLAMA_URL: 'http://host:11434/' }).baseUrl, 'http://host:11434');
});

test('不正な数値は既定へフォールバックする（起動を壊さない）', () => {
  assert.equal(loadJudgeConfig({ JUDGE_ATTEMPT_TIMEOUT_MS: 'abc' }).attemptTimeoutMs, 300000);
  assert.equal(loadJudgeConfig({ JUDGE_MAX_STATE_BYTES: '-1' }).maxStateBytes, 8192);
});

test('3 層の時間制御は env で上書きできる', () => {
  const config = loadJudgeConfig({
    JUDGE_ATTEMPT_TIMEOUT_MS: '120000',
    JUDGE_REQUEST_BUDGET_MS: '300000',
    JUDGE_MAX_RETRY_WAIT_MS: '5000',
  });
  assert.equal(config.attemptTimeoutMs, 120000);
  assert.equal(config.requestBudgetMs, 300000);
  assert.equal(config.maxRetryWaitMs, 5000);
});

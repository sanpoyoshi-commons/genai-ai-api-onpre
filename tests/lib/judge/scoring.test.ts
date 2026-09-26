import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJudgeError } from '../../../src/lib/judge/errors.js';
import { confidenceOf, expectedScore, normalizeToken, scoreCandidates } from '../../../src/lib/judge/scoring.js';

const ln = Math.log;

test('全角・先頭空白・書式付きのトークンを候補へ正規化して照合する', () => {
  const scored = scoreCandidates(
    [
      { token: 'Ａ', logprob: ln(0.5) }, // 全角
      { token: ' B', logprob: ln(0.25) }, // 先頭空白
      { token: '**', logprob: ln(0.15) }, // 候補外（書式だけ）
      { token: 'C', logprob: ln(0.1) },
    ],
    ['A', 'B', 'C'],
  );

  // 候補外（0.15）を除いた 0.85 の中で再正規化される。
  assert.deepEqual(scored.probabilities, { A: 0.588235, B: 0.294118, C: 0.117647 });
  assert.equal(scored.top, 'A');
  assert.equal(scored.confidence, 0.382353);
});

test('`**B**` のように前後へ記号が付いたトークンも候補 B に合算する', () => {
  const scored = scoreCandidates(
    [
      { token: '**B**', logprob: ln(0.4) },
      { token: 'B', logprob: ln(0.2) },
      { token: 'A', logprob: ln(0.4) },
    ],
    ['A', 'B'],
  );
  // B は 0.4 + 0.2 = 0.6 に合算される。
  assert.deepEqual(scored.probabilities, { A: 0.4, B: 0.6 });
  assert.equal(scored.top, 'B');
});

test('候補が一部しか現れない場合は現れた候補の中で再正規化する', () => {
  const scored = scoreCandidates([{ token: 'A', logprob: ln(0.3) }], ['A', 'B']);
  assert.deepEqual(scored.probabilities, { A: 1, B: 0 });
  assert.equal(scored.confidence, 1);
});

test('候補が全部圏外ならエラー（一様分布で埋めない）', () => {
  assert.throws(
    () => scoreCandidates([{ token: 'それ', logprob: ln(0.9) }], ['A', 'B']),
    (err: unknown) => isJudgeError(err) && err.code === 'no_candidate',
  );
});

test('本文断片は候補の逆方向前方一致で誤って数えない（ALSO を A にしない）', () => {
  const scored = scoreCandidates(
    [
      { token: 'ALSO', logprob: ln(0.9) },
      { token: 'B', logprob: ln(0.1) },
    ],
    ['A', 'B'],
  );
  assert.deepEqual(scored.probabilities, { A: 0, B: 1 });
  assert.equal(scored.top, 'B');
});

test('num_predict:1 で頭だけ見える複数トークン語は前方一致で候補に寄せる（Y → Yes）', () => {
  const scored = scoreCandidates(
    [
      { token: 'Y', logprob: ln(0.8) },
      { token: 'No', logprob: ln(0.2) },
    ],
    ['Yes', 'No'],
  );
  assert.deepEqual(scored.probabilities, { Yes: 0.8, No: 0.2 });
  assert.equal(scored.top, 'Yes');
  assert.equal(scored.confidence, 0.6);
});

test('confidence は本家式 clamp((N × max_p − 1) / (N − 1), 0, 1)', () => {
  assert.equal(confidenceOf(1, 2), 1);
  assert.equal(confidenceOf(0.5, 2), 0);
  assert.equal(confidenceOf(0.2, 3), 0); // 負はクランプ
  assert.equal(confidenceOf(0.9, 5), 0.875);
});

test('score は Σ i·pᵢ', () => {
  const probabilities = { '0': 0.1, '1': 0.2, '2': 0.4, '3': 0.2, '4': 0.1 };
  assert.equal(expectedScore(probabilities, ['0', '1', '2', '3', '4']), 2);
});

test('normalizeToken は trim → NFKC → 大文字化', () => {
  assert.equal(normalizeToken(' ｂ '), 'B');
  assert.equal(normalizeToken('ｙｅｓ'), 'YES');
});

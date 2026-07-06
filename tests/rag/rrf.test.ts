import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reciprocalRankFusion } from '../../src/lib/rag/rrf.js';

test('単一リストは順位順・スコア降順', () => {
  const fused = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]], { k: 60, topM: 10 });
  assert.deepEqual(
    fused.map((f) => f.id),
    ['a', 'b', 'c'],
  );
  assert.ok((fused[0]?.score ?? 0) > (fused[1]?.score ?? 0));
});

test('複数リストで寄与を加算（両リスト上位の id が勝つ）', () => {
  const vector = [{ id: 'x' }, { id: 'y' }];
  const bigm = [{ id: 'y' }, { id: 'z' }];
  const fused = reciprocalRankFusion([vector, bigm], { k: 60, topM: 10 });
  // y は vector rank2 ＋ bigm rank1 ＝ 2 リスト寄与で最上位。
  assert.equal(fused[0]?.id, 'y');
  assert.equal(fused.length, 3);
});

test('topM で切り詰める', () => {
  const list = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
  const fused = reciprocalRankFusion([list], { k: 60, topM: 2 });
  assert.equal(fused.length, 2);
});

test('同点は初出順を保つ（安定）', () => {
  const fused = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'b' }]], { k: 60, topM: 10 });
  assert.deepEqual(
    fused.map((f) => f.id),
    ['a', 'b'],
  );
  assert.equal(fused[0]?.score, fused[1]?.score);
});

test('空リストは空配列', () => {
  assert.deepEqual(reciprocalRankFusion([[], []]), []);
});

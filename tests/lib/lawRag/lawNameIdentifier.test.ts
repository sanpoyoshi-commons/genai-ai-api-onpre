import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractLawIdentifier,
  identifierAppearsInQuery,
  identifierKey,
  identifiersMatch,
  normalizeLawName,
} from '../../../src/lib/lawRag/lawNameIdentifier.js';

test('normalizeLawName: NFKC・空白・括弧書き・制定番号を落とす', () => {
  assert.equal(normalizeLawName('防災庁 設置法'), '防災庁設置法');
  assert.equal(normalizeLawName('民法（明治二十九年法律第八十九号）'), '民法');
  assert.equal(normalizeLawName('ＡＩ関連法'), 'AI関連法');
});

test('normalizeLawName: 題名が制定番号だけの旧法令は括弧内を題名として採る', () => {
  // 括弧と制定番号を両方落とすと空になる。落として空なら括弧内が実質の題名。
  assert.equal(
    normalizeLawName('大正三年法律第三十七号（公共団体ノ管理スル公共用土地物件ノ使用ニ関スル法律）'),
    '公共団体ノ管理スル公共用土地物件ノ使用ニ関スル法律',
  );
});

test('extractLawIdentifier: 法形式の接尾辞を剥がして固有部分を残す', () => {
  assert.equal(extractLawIdentifier('防災庁設置法'), '防災庁');
  assert.equal(extractLawIdentifier('復興庁設置法'), '復興庁');
  assert.equal(extractLawIdentifier('労働基準法施行規則'), '労働基準');
  assert.equal(extractLawIdentifier('個人情報の保護に関する法律'), '個人情報の保護');
});

test('extractLawIdentifier: 剥がすと短すぎる名称は名称全体を識別子にする', () => {
  // 「民」「刑」まで削ると識別力を失う（設計 §5）。
  assert.equal(extractLawIdentifier('民法'), '民法');
  assert.equal(extractLawIdentifier('刑法'), '刑法');
});

test('identifierKey: 助詞と末尾の「等」を落として表記ゆれを吸収する', () => {
  assert.equal(identifierKey('個人情報の保護'), '個人情報保護');
  assert.equal(identifierKey('防衛省の職員の俸給の切替え等'), '防衛省職員俸給切替え');
  // 語中の「等」は残す（「均等」「高等」を壊さない）。
  assert.ok(identifierKey('男女雇用機会均等').includes('均'));
});

test('identifiersMatch: 「◯◯庁設置法」同士を固有部分で区別する（bigram では区別できない）', () => {
  // 実測 bigm_similarity('防災庁設置法','復興庁設置法') = 0.5714 > 既定 similarity_limit 0.3。
  assert.equal(identifiersMatch('防災庁設置法', '復興庁設置法'), false);
  assert.equal(identifiersMatch('防災庁設置法', '防災庁設置法'), true);
});

test('identifiersMatch: 通称と正式名称の助詞差は吸収し、別主題は通さない', () => {
  assert.equal(identifiersMatch('個人情報保護法', '個人情報の保護に関する法律'), true);
  // 包含を採らない理由（安全側）：「会社」⊂「会社更生」を通すと別法を根拠にしてしまう。
  assert.equal(identifiersMatch('会社法', '会社更生法'), false);
  assert.equal(identifiersMatch('宇宙移民法', '宇宙基本法'), false);
});

test('identifiersMatch: 法／施行令／施行規則の同族は一致する（施行令補完が効くため）', () => {
  assert.equal(identifiersMatch('労働基準法', '労働基準法施行規則'), true);
});

test('identifierAppearsInQuery: 法令名を名乗らない自然文は固有部分の在否で判定する', () => {
  const q = '防災庁はもう設置されていますか';
  assert.equal(identifierAppearsInQuery('防災庁設置法', q), true);
  assert.equal(identifierAppearsInQuery('復興庁設置法', q), false);
});

test('identifierAppearsInQuery: クエリが法令名を名乗るときは語どうしで突き合わせる（部分文字列の誤通過を断つ）', () => {
  const q = '宇宙移民法の要件は';
  // 「宇宙移民法」には「民法」が部分文字列として含まれる。単純な包含だと民法が通ってしまう
  // （法令名マスタ 7,826 件の全数探索で実際に検出・2026-09-19）。
  assert.equal(identifierAppearsInQuery('民法', q), false);
  assert.equal(identifierAppearsInQuery('宇宙基本法', q), false);
  assert.equal(identifierAppearsInQuery('宇宙政策委員会令', q), false);
});

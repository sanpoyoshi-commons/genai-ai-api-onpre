import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmClient, LlmGenerateInput } from '../../../src/lib/llm/llmClient.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LawNameEstimator,
  applyLawNameAliases,
  expandLawNamesWithOrdinances,
  extractLawNamesFromQuery,
  parseLawNames,
  resolveLawNameAliases,
} from '../../../src/lib/lawRag/lawNameEstimator.js';

// ── parseLawNames: 4 段フォールバック ──────────────────

test('parseLawNames Stage1: direct JSON', () => {
  assert.deepEqual(parseLawNames('{"law_names": ["労働基準法", "労働契約法"]}'), [
    '労働基準法',
    '労働契約法',
  ]);
});

test('parseLawNames Stage1: JSON wrapped in ```json fences', () => {
  const raw = '```json\n{"law_names": ["民法"]}\n```';
  assert.deepEqual(parseLawNames(raw), ['民法']);
});

test('parseLawNames Stage2: JSON embedded in prose', () => {
  const raw = 'はい、こちらです。{"law_names": ["会社法"]} 以上です。';
  assert.deepEqual(parseLawNames(raw), ['会社法']);
});

test('parseLawNames Stage3: plain-text law names when no JSON', () => {
  const raw = '関連する法令は、労働基準法 と 最低賃金法 です。';
  const names = parseLawNames(raw);
  assert.ok(names.some((n) => n.includes('労働基準法')));
});

test('parseLawNames Stage4: markdown bold/list', () => {
  const raw = '- **個人情報の保護に関する法律**\n- **行政手続法**';
  const names = parseLawNames(raw);
  assert.ok(names.some((n) => n.includes('個人情報の保護に関する法律')));
  assert.ok(names.some((n) => n.includes('行政手続法')));
});

test('parseLawNames: empty array stays empty (no hit → caller falls back)', () => {
  assert.deepEqual(parseLawNames('{"law_names": []}'), []);
});

test('parseLawNames: unparseable / no law tokens → []', () => {
  assert.deepEqual(parseLawNames('わかりません。'), []);
});

test('parseLawNames: dedupes and caps at 10', () => {
  const dup = JSON.stringify({ law_names: Array.from({ length: 15 }, (_, i) => `法${i % 3}`) });
  const out = parseLawNames(dup);
  assert.equal(out.length, 3); // 法0/法1/法2
});

// ── extractLawNamesFromQuery ───────────────────────────

test('extractLawNamesFromQuery picks law-like tokens >=4 chars', () => {
  const out = extractLawNamesFromQuery('労働基準法と会社法について、行政法の一般論は除く');
  assert.ok(out.includes('労働基準法'));
  // 「会社法」は3文字なので除外、「行政法」も3文字で除外。
  assert.ok(!out.includes('会社法'));
});

// ── expandLawNamesWithOrdinances ───────────────────────

test('expandLawNamesWithOrdinances appends 施行令/施行規則 for 法/法律', () => {
  assert.deepEqual(expandLawNamesWithOrdinances(['個人情報保護法']), [
    '個人情報保護法',
    '個人情報保護法施行令',
    '個人情報保護法施行規則',
  ]);
});

test('expandLawNamesWithOrdinances leaves 規則/政令 untouched and dedupes', () => {
  assert.deepEqual(expandLawNamesWithOrdinances(['ある規則', 'ある規則']), ['ある規則']);
});

// ── applyLawNameAliases（通称→正式名称・辞書注入） ──────

const TEST_ALIASES = {
  労働者派遣法: '労働者派遣事業の適正な運営の確保及び派遣労働者の保護等に関する法律',
  短時間有期雇用労働法: '短時間労働者及び有期雇用労働者の雇用管理の改善等に関する法律',
};

test('applyLawNameAliases maps colloquial 派遣法 to formal title (fixes nearest-neighbor mismatch)', () => {
  assert.deepEqual(applyLawNameAliases(['労働者派遣法'], TEST_ALIASES), [
    '労働者派遣事業の適正な運営の確保及び派遣労働者の保護等に関する法律',
  ]);
});

test('applyLawNameAliases replaces (not adds) so the wrong-resolving colloquial is excluded', () => {
  // gemma 実出力例：[労働基準法, 労働者派遣法] → 労基法は素通し・派遣法は正式名称へ置換。
  assert.deepEqual(applyLawNameAliases(['労働基準法', '労働者派遣法'], TEST_ALIASES), [
    '労働基準法',
    '労働者派遣事業の適正な運営の確保及び派遣労働者の保護等に関する法律',
  ]);
});

test('applyLawNameAliases normalizes spacing/中黒 in input names', () => {
  // 入力側に中黒・空白が入っても正規化して辞書キー（正規化済み）へマッチ。
  assert.deepEqual(applyLawNameAliases(['短時間・有期 雇用労働法'], TEST_ALIASES), [
    '短時間労働者及び有期雇用労働者の雇用管理の改善等に関する法律',
  ]);
});

test('applyLawNameAliases leaves unknown names untouched and dedupes', () => {
  assert.deepEqual(applyLawNameAliases(['会社法', '会社法', '謎の法'], TEST_ALIASES), [
    '会社法',
    '謎の法',
  ]);
});

test('applyLawNameAliases with empty dict is a pass-through (dedupe only)', () => {
  assert.deepEqual(applyLawNameAliases(['労働者派遣法', '労働者派遣法'], {}), ['労働者派遣法']);
});

// ── resolveLawNameAliases（JSON 設定ファイル読込） ───────

test('resolveLawNameAliases returns {} when env unset (辞書機能オフ＝素の解決)', () => {
  assert.deepEqual(resolveLawNameAliases({}), {});
});

test('resolveLawNameAliases reads JSON file and normalizes keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alias-'));
  const file = join(dir, 'aliases.json');
  // JSON は中黒・空白入りの自然な通称で書ける（読込時に正規化）。
  writeFileSync(file, JSON.stringify({ 'パートタイム・有期雇用労働法': '正式名称X', 派遣法: '正式名称Y' }));
  const aliases = resolveLawNameAliases({ LAW_RAG_ALIASES_FILE: file });
  // 正規化済みキーで引ける。
  assert.equal(applyLawNameAliases(['パートタイム有期雇用労働法'], aliases)[0], '正式名称X');
  assert.equal(applyLawNameAliases(['派遣法'], aliases)[0], '正式名称Y');
});

test('resolveLawNameAliases falls back to {} on unreadable file (起動を壊さない)', () => {
  assert.deepEqual(resolveLawNameAliases({ LAW_RAG_ALIASES_FILE: '/nonexistent/aliases.json' }), {});
});

test('resolveLawNameAliases ignores non-string values and array/non-object roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alias-'));
  const okFile = join(dir, 'mixed.json');
  writeFileSync(okFile, JSON.stringify({ 派遣法: '正式名称Y', 壊れ: 123, 空: '' }));
  assert.deepEqual(resolveLawNameAliases({ LAW_RAG_ALIASES_FILE: okFile }), { 派遣法: '正式名称Y' });
  const arrFile = join(dir, 'arr.json');
  writeFileSync(arrFile, JSON.stringify(['a', 'b']));
  assert.deepEqual(resolveLawNameAliases({ LAW_RAG_ALIASES_FILE: arrFile }), {});
});

// ── LawNameEstimator（LlmClient 注入） ──────────────────

test('LawNameEstimator builds system+user messages and parses output', async () => {
  let captured: LlmGenerateInput | null = null;
  const llm: LlmClient = {
    async generate(input) {
      captured = input;
      return '{"law_names": ["労働基準法"]}';
    },
    async *generateStream() {
      // unused
    },
  };
  const est = new LawNameEstimator(llm);
  const names = await est.estimate('残業の上限は？', 'gemma', 'req-1');
  assert.deepEqual(names, ['労働基準法']);
  assert.equal(captured?.messages.length, 2);
  assert.equal(captured?.messages[0]?.role, 'system');
  assert.equal(captured?.messages[1]?.role, 'user');
  assert.equal(captured?.messages[1]?.content, '残業の上限は？');
  assert.equal(captured?.model, 'gemma');
});

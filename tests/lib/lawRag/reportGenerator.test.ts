import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LlmClient, LlmGenerateInput } from '../../../src/lib/llm/llmClient.js';
import {
  GENERATE_REPORT_SYSTEM_PROMPT,
  ReportGenerator,
  resolveReportSystemPrompt,
  stripReportPreamble,
  stripThinkBlocks,
} from '../../../src/lib/lawRag/reportGenerator.js';

// ── resolveReportSystemPrompt（設定上書き） ─────────────

test('resolveReportSystemPrompt: env 未設定なら組込み既定', () => {
  assert.equal(resolveReportSystemPrompt({} as NodeJS.ProcessEnv), GENERATE_REPORT_SYSTEM_PROMPT);
});

test('resolveReportSystemPrompt: LAW_RAG_REPORT_PROMPT_FILE 指定でファイル内容を使う（trim）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-prompt-'));
  const file = join(dir, 'p.txt');
  writeFileSync(file, '  カスタムプロンプト本文  \n', 'utf8');
  assert.equal(
    resolveReportSystemPrompt({ LAW_RAG_REPORT_PROMPT_FILE: file } as NodeJS.ProcessEnv),
    'カスタムプロンプト本文',
  );
});

test('resolveReportSystemPrompt: 読めない/空ファイルは既定へ安全フォールバック（throw しない）', () => {
  assert.equal(
    resolveReportSystemPrompt({ LAW_RAG_REPORT_PROMPT_FILE: '/no/such/file.txt' } as NodeJS.ProcessEnv),
    GENERATE_REPORT_SYSTEM_PROMPT,
  );
  const dir = mkdtempSync(join(tmpdir(), 'law-prompt-'));
  const empty = join(dir, 'empty.txt');
  writeFileSync(empty, '   \n', 'utf8');
  assert.equal(
    resolveReportSystemPrompt({ LAW_RAG_REPORT_PROMPT_FILE: empty } as NodeJS.ProcessEnv),
    GENERATE_REPORT_SYSTEM_PROMPT,
  );
});

test('ReportGenerator: systemPrompt 明示注入を generate で使う', async () => {
  let captured: LlmGenerateInput | null = null;
  const llm: LlmClient = {
    async generate(input) {
      captured = input;
      return '# レポート';
    },
    async *generateStream() {},
  };
  await new ReportGenerator(llm, 'カスタムSYS').generate('q', 'refs', 'gemma', 'r');
  assert.equal(captured?.messages[0]?.content, 'カスタムSYS');
});

// ── stripThinkBlocks ───────────────────────────────────

test('stripThinkBlocks removes <think> and <thinking> blocks', () => {
  assert.equal(stripThinkBlocks('<think>考え中</think>本文'), '本文');
  assert.equal(stripThinkBlocks('<thinking>x</thinking>\n# 見出し'), '\n# 見出し');
});

// ── stripReportPreamble ────────────────────────────────

test('stripReportPreamble drops preamble before first heading', () => {
  const raw = 'まず分類します。これは定義確認型です。\n\n# 不法行為責任\n本文 [1]。';
  assert.equal(stripReportPreamble(raw), '# 不法行為責任\n本文 [1]。');
});

test('stripReportPreamble keeps text as-is (trimmed) when no heading', () => {
  assert.equal(stripReportPreamble('  見出しの無いテキスト  '), '見出しの無いテキスト');
});

test('stripReportPreamble strips think block then finds heading', () => {
  const raw = '<think>分類検討</think>\n前置き\n# タイトル\n本文';
  assert.equal(stripReportPreamble(raw), '# タイトル\n本文');
});

// ── ReportGenerator（LlmClient 注入） ───────────────────

test('ReportGenerator builds system+user messages and cleans output', async () => {
  let captured: LlmGenerateInput | null = null;
  const llm: LlmClient = {
    async generate(input) {
      captured = input;
      return '前置き文\n# レポート\n民法第709条は不法行為責任を規定します [1]。';
    },
    async *generateStream() {},
  };
  const report = await new ReportGenerator(llm).generate(
    '不法行為とは？',
    '[1] 【e-laws公式条文】 民法 第709条\n故意又は過失によって…',
    'gemma',
    'req-1',
  );
  assert.equal(report, '# レポート\n民法第709条は不法行為責任を規定します [1]。');
  assert.equal(captured?.messages.length, 2);
  assert.equal(captured?.messages[0]?.role, 'system');
  assert.ok(captured?.messages[1]?.content.includes('不法行為とは？'));
  assert.ok(captured?.messages[1]?.content.includes('【e-laws公式条文】'));
  assert.equal(captured?.model, 'gemma');
});

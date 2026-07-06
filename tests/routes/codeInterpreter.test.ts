import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { LlmClient, LlmGenerateInput } from '../../src/lib/llm/llmClient.js';
import type { CodeInterpreterConfig } from '../../src/lib/sandbox/config.js';
import { SandboxError } from '../../src/lib/sandbox/errors.js';
import type { SandboxClient, SandboxExecInput, SandboxExecResult } from '../../src/lib/sandbox/sandboxClient.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createCodeInterpreterRouter } from '../../src/routes/codeInterpreter/index.js';

// ── fake コード生成 LLM（固定/スクリプト応答＋呼出回数） ──
let llmResponses: string[] = [];
let llmCalls = 0;
const fakeLlm: LlmClient = {
  async generate(_input: LlmGenerateInput): Promise<string> {
    llmCalls += 1;
    return llmResponses.shift() ?? llmResponses[llmResponses.length - 1] ?? '```python\nprint("ok")\n```';
  },
  async *generateStream(_input: LlmGenerateInput): AsyncIterable<string> {
    yield '';
  },
};

// ── fake サンドボックス（スクリプト応答 or throw＋呼出回数） ──
let sandboxResults: SandboxExecResult[] = [];
let sandboxThrow: Error | null = null;
let sandboxCalls = 0;
const fakeSandbox: SandboxClient = {
  async execute(_input: SandboxExecInput): Promise<SandboxExecResult> {
    sandboxCalls += 1;
    if (sandboxThrow) {
      throw sandboxThrow;
    }
    return sandboxResults.shift() ?? sandboxResults[sandboxResults.length - 1] ?? okResult();
  },
};

function okResult(stdout = '分析完了', files: { name: string; bytes: Buffer }[] = []): SandboxExecResult {
  return { status: 'ok', exitCode: 0, stdout, stderr: '', files };
}

// 同一オブジェクト参照を route が握るので、フィールド変更で試行回数/上限を制御できる。
const config: CodeInterpreterConfig = { execTimeoutMs: 60000, maxAttempts: 3, maxTotalFileBytes: 25 * 1024 * 1024 };

let server: Server | undefined;
let baseUrl: string;
let currentAuth: AuthContext;

before(async () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use('/api', createCodeInterpreterRouter({ llm: fakeLlm, sandbox: fakeSandbox, config }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server?.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => server?.close());

beforeEach(() => {
  llmResponses = [];
  llmCalls = 0;
  sandboxResults = [];
  sandboxThrow = null;
  sandboxCalls = 0;
  config.execTimeoutMs = 60000;
  config.maxAttempts = 3;
  config.maxTotalFileBytes = 25 * 1024 * 1024;
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

const b64 = (s: string) => Buffer.from(s).toString('base64');

function reqBody(inputText: string, files: { filename: string; content: string }[]) {
  return JSON.stringify({ inputs: { input_text: inputText, files: [{ key: 'excel_file', files }] } });
}

test('正常: チャートを源内 IF（outputs + artifacts[base64]）で返す', async () => {
  llmResponses = ['```python\nprint("done")\n```'];
  const png = Buffer.from('PNGDATA');
  sandboxResults = [okResult('カテゴリ別に集計しました', [{ name: 'chart.png', bytes: png }])];

  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('カテゴリ別に集計して棒グラフにして', [{ filename: 'data.csv', content: b64('a,b\n1,2\n') }]),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { outputs: string; artifacts: { display_name: string; content: string }[] };
  assert.equal(body.outputs, 'カテゴリ別に集計しました');
  assert.equal(body.artifacts.length, 1);
  assert.equal(body.artifacts[0]?.display_name, 'chart.png');
  assert.equal(body.artifacts[0]?.content, png.toString('base64'));
  assert.equal(llmCalls, 1);
  assert.equal(sandboxCalls, 1);
});

test('400: CSV/Excel 以外の拡張子は弾く（LLM/サンドボックス未呼出）', async () => {
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('分析して', [{ filename: 'data.txt', content: b64('hello') }]),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /CSV\/Excel/);
  assert.equal(llmCalls, 0);
  assert.equal(sandboxCalls, 0);
});

test('400: input_text 空は弾く', async () => {
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('', [{ filename: 'data.csv', content: b64('a,b\n1,2\n') }]),
  });
  assert.equal(res.status, 400);
  assert.equal(llmCalls, 0);
});

test('400: 合計サイズ上限超過は弾く', async () => {
  config.maxTotalFileBytes = 4;
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('分析して', [{ filename: 'data.csv', content: b64('aaaaaaaaaa') }]),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /合計サイズ/);
  assert.equal(sandboxCalls, 0);
});

test('500: サンドボックス到達失敗（down）は 500', async () => {
  llmResponses = ['```python\nprint(1)\n```'];
  sandboxThrow = new SandboxError('down', 'サンドボックスに接続できませんでした。');
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('分析して', [{ filename: 'data.csv', content: b64('a,b\n1,2\n') }]),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /接続できませんでした/);
});

test('500: HTTP タイムアウト（transport）は 500', async () => {
  llmResponses = ['```python\nprint(1)\n```'];
  sandboxThrow = new SandboxError('timeout', 'サンドボックスへの呼び出しがタイムアウトしました。');
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('分析して', [{ filename: 'data.csv', content: b64('a,b\n1,2\n') }]),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /タイムアウト/);
});

test('再試行: error→ok で 2 回試行し成功（LLM/サンドボックス 2 回）', async () => {
  llmResponses = ['```python\nbad\n```', '```python\ngood\n```'];
  sandboxResults = [
    { status: 'error', exitCode: 1, stdout: '', stderr: 'NameError: bad', files: [] },
    okResult('修正後に成功', [{ name: 'chart.png', bytes: Buffer.from('X') }]),
  ];
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('分析して', [{ filename: 'data.csv', content: b64('a,b\n1,2\n') }]),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { outputs: string };
  assert.equal(body.outputs, '修正後に成功');
  assert.equal(llmCalls, 2);
  assert.equal(sandboxCalls, 2);
});

test('再試行なし（maxAttempts=1）: 失敗は即 500（単発）', async () => {
  config.maxAttempts = 1;
  llmResponses = ['```python\nbad\n```'];
  sandboxResults = [{ status: 'error', exitCode: 1, stdout: '', stderr: 'boom', files: [] }];
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('分析して', [{ filename: 'data.csv', content: b64('a,b\n1,2\n') }]),
  });
  assert.equal(res.status, 500);
  assert.equal(llmCalls, 1);
  assert.equal(sandboxCalls, 1);
});

test('artifacts は PNG のみ（非 PNG は除外）', async () => {
  llmResponses = ['```python\nprint(1)\n```'];
  sandboxResults = [
    okResult('ok', [
      { name: 'chart.png', bytes: Buffer.from('P') },
      { name: 'data.json', bytes: Buffer.from('{}') },
    ]),
  ];
  const res = await api('/code-interpreter/responses', {
    method: 'POST',
    body: reqBody('分析して', [{ filename: 'data.xlsx', content: b64('xlsxbytes') }]),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { artifacts: { display_name: string }[] };
  assert.equal(body.artifacts.length, 1);
  assert.equal(body.artifacts[0]?.display_name, 'chart.png');
});

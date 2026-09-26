import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../../src/lib/auth/context.js';
import { USER_GROUP } from '../../../src/lib/auth/groups.js';
import { errorHandler } from '../../../src/lib/http/createApiHandler.js';
import type { JudgeConfig } from '../../../src/lib/judge/config.js';
import { JudgeError } from '../../../src/lib/judge/errors.js';
import { JudgeService } from '../../../src/lib/judge/judgeService.js';
import type { JudgeLlmClient, JudgeLlmResult } from '../../../src/lib/judge/ollamaNativeClient.js';
import type { JudgePrompt } from '../../../src/lib/judge/prompt.js';
import { requestContext } from '../../../src/middleware/requestContext.js';
import { createJudgeRouter } from '../../../src/routes/judge/index.js';

const ln = Math.log;

const config: JudgeConfig = {
  baseUrl: 'http://ollama:11434',
  defaultModel: 'gemma4:e2b',
  allowedModels: ['gemma4:e2b', 'gemma4:e2b-it-qat'],
  contextLength: 8192,
  maxStateBytes: 8192,
  attemptTimeoutMs: 90000,
  requestBudgetMs: 180000,
  maxRetryWaitMs: 60000,
};

let candidates: { token: string; logprob: number }[];
let promptEvalCount: number;
let failWith: JudgeError | undefined;
let reportUsage = true;
let lastPrompt: JudgePrompt | undefined;

const fakeLlm: JudgeLlmClient = {
  async nextTokenLogprobs(prompt: JudgePrompt): Promise<JudgeLlmResult> {
    lastPrompt = prompt;
    if (failWith) {
      throw failWith;
    }
    return {
      model: 'gemma4:e2b',
      candidates,
      ...(reportUsage ? { promptEvalCount, evalCount: 1 } : {}),
    };
  },
};

let server: Server | undefined;
let baseUrl: string;
let currentAuth: AuthContext;
let currentConfig: JudgeConfig;

before(async () => {
  const app = express();
  app.use(requestContext);
  // 本番（src/app.ts）と同じ本文上限にする。既定の 100kb では 10 万段の本文（約 195KB）が
  // 入口で 413 になり、深さの検査まで届かないため。
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => {
    req.auth = currentAuth;
    next();
  });
  // config は毎テストで差し替えられるよう、リクエスト時に読む薄いラッパを挟む。
  app.use('/api', (req, res, next) => {
    createJudgeRouter({ judge: new JudgeService(fakeLlm, currentConfig) })(req, res, next);
  });
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
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
  currentConfig = { ...config };
  candidates = [
    { token: 'A', logprob: ln(0.75) },
    { token: 'B', logprob: ln(0.25) },
  ];
  promptEvalCount = 150;
  failWith = undefined;
  reportUsage = true;
  lastPrompt = undefined;
});

const judge = (body: unknown) =>
  fetch(`${baseUrl}/api/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 生の本文をそのまま送る（極端に深い入れ子は JS のオブジェクトを経由せず文字列で組む）。 */
const judgeRaw = (raw: string) =>
  fetch(`${baseUrl}/api/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });

test('3 型すべてを 1 リクエストで返し、model に実際のモデル名が入る', async () => {
  // noul / choice のどちらの候補も混ざった分布（実機でも候補以外のトークンが混ざる）。
  candidates = [
    { token: 'Yes', logprob: ln(0.6) },
    { token: 'No', logprob: ln(0.1) },
    { token: 'A', logprob: ln(0.2) },
    { token: 'B', logprob: ln(0.1) },
  ];
  const res = await judge({
    state: { 件名: '至急ご確認ください' },
    questions: {
      urgent: { type: 'noul', instructions: '緊急か' },
      category: { type: 'choice', instructions: '分類', criteria: ['問い合わせ', '障害'] },
    },
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.model, 'gemma4:e2b');
  assert.equal(body.answers.urgent.type, 'noul');
  assert.equal(typeof body.answers.urgent.noul, 'boolean');
  assert.equal(body.answers.urgent.noul, true);
  assert.equal(body.answers.category.choice, 'A');
  assert.deepEqual(body.answers.category.probabilities, { A: 0.666667, B: 0.333333 });
  assert.equal(body.answers.category.confidence, 0.333333);
  assert.deepEqual(body.usage, { input_tokens: 300, output_tokens: 2 });
});

test('score は期待値と legend を返す', async () => {
  candidates = [
    { token: '0', logprob: ln(0.2) },
    { token: '1', logprob: ln(0.3) },
    { token: '2', logprob: ln(0.5) },
  ];
  const res = await judge({
    state: 'テキストの state',
    questions: { severity: { type: 'score', instructions: '深刻度', criteria: ['低', '中', '高'] } },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.answers.severity.score, 1.3);
  assert.deepEqual(body.answers.severity.legend, { '0': '低', '1': '中', '2': '高' });
});

test('未知の type は 400', async () => {
  const res = await judge({ state: 'x', questions: { q: { type: 'rank', instructions: 'q' } } });
  assert.equal(res.status, 400);
});

test('問い名が規則外なら 400', async () => {
  const res = await judge({ state: 'x', questions: { 'bad name': { type: 'noul', instructions: 'q' } } });
  assert.equal(res.status, 400);
});

test('問いが 17 個なら 400', async () => {
  const questions: Record<string, unknown> = {};
  for (let i = 0; i < 17; i += 1) {
    questions[`q${i}`] = { type: 'noul', instructions: 'q' };
  }
  const res = await judge({ state: 'x', questions });
  assert.equal(res.status, 400);
});

test('choice の選択肢が 21 件なら 400', async () => {
  const criteria = Array.from({ length: 21 }, (_, i) => `c${i}`);
  const res = await judge({ state: 'x', questions: { q: { type: 'choice', instructions: 'q', criteria } } });
  assert.equal(res.status, 400);
});

test('許可リスト外の model は 400', async () => {
  const res = await judge({
    state: 'x',
    model: 'llama3.2:3b',
    questions: { q: { type: 'noul', instructions: 'q' } },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'このモデルは使用できません。' });
});

test('state が上限超過なら 400（state 本文は応答に含めない）', async () => {
  currentConfig = { ...config, maxStateBytes: 50 };
  const secret = 'ひみつの本文';
  const res = await judge({
    state: secret.repeat(20),
    questions: { q: { type: 'noul', instructions: 'q' } },
  });
  assert.equal(res.status, 400);
  const body = (await res.text()) as string;
  assert.ok(!body.includes(secret), 'エラー応答に state を含めない');
});

test('コンテキスト超過の恐れがある入力は 422 で止まる', async () => {
  currentConfig = { ...config, contextLength: 400, maxStateBytes: 8192 };
  const res = await judge({
    state: 'あ'.repeat(300),
    questions: { q: { type: 'noul', instructions: 'q' } },
  });
  assert.equal(res.status, 422);
});

test('上流失敗は 502、タイムアウトは 504、モデル未設定は 503', async () => {
  failWith = new JudgeError('upstream', '判定モデルがエラーを返しました（HTTP 500）');
  assert.equal((await judge({ state: 'x', questions: { q: { type: 'noul', instructions: 'q' } } })).status, 502);

  failWith = new JudgeError('timeout', 'タイムアウト');
  assert.equal((await judge({ state: 'x', questions: { q: { type: 'noul', instructions: 'q' } } })).status, 504);

  failWith = undefined;
  currentConfig = { ...config, defaultModel: undefined, allowedModels: [] };
  assert.equal((await judge({ state: 'x', questions: { q: { type: 'noul', instructions: 'q' } } })).status, 503);
});

test('候補が全部圏外なら 502（一様分布で埋めない）', async () => {
  candidates = [{ token: 'それは', logprob: ln(0.9) }];
  const res = await judge({ state: 'x', questions: { q: { type: 'noul', instructions: 'q' } } });
  assert.equal(res.status, 502);
});

test('ログに state 本文と確率値を出さない', async () => {
  const marker = 'ログ流出検知用マーカー文字列';
  const captured: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  try {
    const res = await judge({
      state: { 本文: marker },
      questions: { q: { type: 'choice', instructions: '分類', criteria: ['甲', '乙'] } },
    });
    assert.equal(res.status, 200);
  } finally {
    process.stdout.write = original;
  }

  const logs = captured.join('');
  assert.ok(!logs.includes(marker), 'state 本文がログに出ている');
  assert.ok(!logs.includes('probabilities'), '確率値がログに出ている');
  assert.ok(!logs.includes('分類'), '問い文がログに出ている');
  // state はプロンプトには入っている（＝ログにだけ出ていないことの確認）。
  assert.ok(lastPrompt?.user.includes(marker));
});

test('state が null なら 400（本家 SDK 間で割れているが、こちらは拒否で固定）', async () => {
  const res = await judge({ state: null, questions: { q: { type: 'noul', instructions: 'q' } } });
  assert.equal(res.status, 400);
  // 既定の 'Invalid input' ではなく、何が悪いか分かる文言を返す。
  assert.deepEqual(await res.json(), {
    error: 'state は文字列・オブジェクト・配列のいずれかです（null は指定できません）',
  });
});

test('choice の criteria はオブジェクト形式も受け、応答は呼び出し側のラベルで返る', async () => {
  candidates = [
    { token: 'A', logprob: ln(0.9) },
    { token: 'B', logprob: ln(0.1) },
  ];
  const res = await judge({
    state: 'x',
    questions: {
      category: { type: 'choice', instructions: '分類', criteria: { inquiry: '問い合わせ', incident: null } },
    },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.answers.category.choice, 'inquiry');
  assert.deepEqual(body.answers.category.probabilities, { inquiry: 0.9, incident: 0.1 });
});

test('criteria の値が null でも受け付ける（説明なしの選択肢）', async () => {
  const res = await judge({
    state: 'x',
    questions: { q: { type: 'choice', instructions: 'q', criteria: [null, null] } },
  });
  assert.equal(res.status, 200);
});

test('上流がトークン数を返さなければ usage のフィールドを省いて返す', async () => {
  reportUsage = false;
  const res = await judge({
    state: 'x',
    questions: { q: { type: 'choice', instructions: 'q', criteria: ['a', 'b'] } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as Record<string, any>).usage, {});
});

// --- 構造化された instructions / criteria（本家 SDK の EntryType に揃えた分） ---

test('構造化した instructions と criteria を受け、ラベルでの応答は変わらない', async () => {
  candidates = [
    { token: 'A', logprob: ln(0.2) },
    { token: 'B', logprob: ln(0.8) },
  ];
  const res = await judge({
    state: '靴を返送して一週間です。返金はいつですか',
    questions: {
      return_topic: {
        type: 'choice',
        instructions: { question: 'どの返品の話題か', focus: '知りたい情報で分類する' },
        criteria: {
          return_policy: { what: '返品できるか', not_for: '送った返品の進捗', examples: ['何日以内に返せますか'] },
          return_status: { what: '送った返品の進捗', not_for: '返品できるか' },
        },
      },
    },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.answers.return_topic.choice, 'return_status');
  assert.deepEqual(body.answers.return_topic.probabilities, { return_policy: 0.2, return_status: 0.8 });
  // 構造化した中身はプロンプトに入る（フィールド名ごと）。
  assert.ok(lastPrompt?.user.includes('"not_for": "返品できるか"'));
  assert.ok(lastPrompt?.user.includes('"focus": "知りたい情報で分類する"'));
});

test('instructions が null なら 400（state と同じ方針＝説明の無い問いは受けない）', async () => {
  const res = await judge({ state: 'x', questions: { q: { type: 'noul', instructions: null } } });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: 'instructions は空でない文字列・オブジェクト・配列のいずれかです（null 不可・入れ子は 8 段まで）',
  });
});

test('【非退行】文字列を渡したときの検証メッセージは main と同じまま', async () => {
  const empty = await judge({ state: 'x', questions: { q: { type: 'noul', instructions: '' } } });
  assert.equal((await empty.json()).error, 'instructions は必須です');

  const emptyEntry = await judge({
    state: 'x',
    questions: { q: { type: 'choice', instructions: 'q', criteria: ['', 'y'] } },
  });
  assert.equal((await emptyEntry.json()).error, 'criteria の要素は空文字にできません');

  const tooFew = await judge({ state: 'x', questions: { q: { type: 'choice', instructions: 'q', criteria: ['x'] } } });
  assert.equal((await tooFew.json()).error, 'choice の criteria は 2〜20 件です');
});

test('入れ子が深すぎる criteria・instructions は 400（文字列化のインデント膨張を入口で止める）', async () => {
  // MAX_ENTRY_DEPTH = 8。入れ物を 9 段重ねた値を作る。
  const deepen = (n: number) => {
    let v: unknown = 'おく';
    for (let i = 0; i < n; i++) {
      v = { n: v };
    }
    return v;
  };
  const deep = deepen(9);

  // choice の criteria は配列形式／オブジェクト形式の union の内側にあるため、zod が出す最初の
  // issue は外側の union のもの（'Invalid input'）になる。これは main と同じ挙動で、
  // criteria の値が不正なとき（数値を渡した場合など）も同様＝本変更で持ち込んだものではない。
  for (const criteria of [{ a: deep, b: null }, [deep, 'y']]) {
    const res = await judge({ state: 'x', questions: { q: { type: 'choice', instructions: 'q', criteria } } });
    assert.equal(res.status, 400);
  }

  // score の criteria と instructions は union の内側にないため、理由が表に出る。
  const score = await judge({ state: 'x', questions: { q: { type: 'score', instructions: 'q', criteria: [deep, 'y'] } } });
  assert.equal(score.status, 400);
  assert.match((await score.json()).error as string, /入れ子は 8 段まで/);

  const instr = await judge({ state: 'x', questions: { q: { type: 'noul', instructions: deep } } });
  assert.equal(instr.status, 400);
  assert.match((await instr.json()).error as string, /入れ子は 8 段まで/);
});

test('上限ぎりぎり（8 段）の入れ子は通る', async () => {
  let deep: unknown = 'おく';
  for (let i = 0; i < 8; i++) {
    deep = { n: deep };
  }
  candidates = [
    { token: 'A', logprob: ln(0.6) },
    { token: 'B', logprob: ln(0.4) },
  ];
  const res = await judge({
    state: 'x',
    questions: { q: { type: 'choice', instructions: 'q', criteria: { a: deep, b: null } } },
  });
  assert.equal(res.status, 200);
});

// --- 極端に深い入れ子（§22-2 の 2） ---

/**
 * 10 万段の入れ子を、JS のオブジェクトを経由せず**文字列として**組む。
 * `JSON.stringify` は深い入れ子で `Maximum call stack size exceeded` になるため、
 * テスト側でオブジェクトを組むと、送る前にテストが落ちてしまう。
 */
const DEEP_JSON = `${'['.repeat(100000)}0${']'.repeat(100000)}`;

test('10 万段の入れ子を criteria・instructions に入れても 400（500 にはならない）', async () => {
  // 本文は約 195KB。JSON.parse は 10 万段でも通るので、入口の本文上限ではなく
  // スキーマの深さ検査で落ちることを確かめる。
  assert.ok(Buffer.byteLength(DEEP_JSON) < 1024 * 1024, '本文が 1MB 未満であること');

  const bodies: [string, string][] = [
    [
      'choice のオブジェクト形式',
      `{"state":"x","questions":{"q":{"type":"choice","instructions":"q","criteria":{"a":${DEEP_JSON},"b":null}}}}`,
    ],
    [
      'choice の配列形式',
      `{"state":"x","questions":{"q":{"type":"choice","instructions":"q","criteria":[${DEEP_JSON},"y"]}}}`,
    ],
    [
      'score の段階',
      `{"state":"x","questions":{"q":{"type":"score","instructions":"q","criteria":[${DEEP_JSON},"y"]}}}`,
    ],
    ['instructions', `{"state":"x","questions":{"q":{"type":"noul","instructions":${DEEP_JSON}}}}`],
  ];

  for (const [label, raw] of bodies) {
    const res = await judgeRaw(raw);
    assert.equal(res.status, 400, `${label} は 400 であること`);
  }
});

test('10 万段の入れ子を state に入れても 400（500 にはならない）', async () => {
  // state には**深さの上限を掛けない**（掛けると従来通っていた入力が落ちる）。代わりに
  // `JSON.stringify(値, null, 2)` が V8 の再帰で溢れたときだけ 400 にする（JSON.parse 自体は通る）。
  const res = await judgeRaw(`{"state":${DEEP_JSON},"questions":{"q":{"type":"noul","instructions":"q"}}}`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'state の入れ子が深すぎます（文字列にできませんでした）' });
});

test('8 段を超える入れ子の state は通る（state に深さの上限は掛けない）', async () => {
  // criteria・instructions の上限（8 段）を state に持ち込んでいないことの固定。
  candidates = [
    { token: 'Yes', logprob: ln(0.8) },
    { token: 'No', logprob: ln(0.2) },
  ];
  // 32 段（JSON 化するとインデントで約 2KB。既定の state 上限 8192 バイトには収まる）。
  const deep = `${'['.repeat(32)}0${']'.repeat(32)}`;
  const res = await judgeRaw(`{"state":${deep},"questions":{"q":{"type":"noul","instructions":"q"}}}`);
  assert.equal(res.status, 200);
});

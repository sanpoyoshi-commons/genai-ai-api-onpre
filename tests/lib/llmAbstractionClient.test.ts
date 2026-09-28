import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LLMAdapter } from '../../src/llm/adapters/base.js';
import type { ChatChunk, ChatInput, ChatOutput } from '../../src/llm/types.js';
import { ATTACHMENT_PREAMBLE } from '../../src/lib/attachments/documents.js';
import { LlmAbstractionClient } from '../../src/lib/llm/llmAbstractionClient.js';

// ── fake adapter（chat は固定応答＋入力捕捉、chatStream は与えたチャンク列を yield） ──
function fakeAdapter(opts: {
  output?: ChatOutput;
  chunks?: ChatChunk[];
  capture?: (input: ChatInput) => void;
  supportsImages?: boolean;
}): LLMAdapter {
  return {
    backend: 'fake',
    supportsImages: opts.supportsImages,
    async chat(input) {
      opts.capture?.(input);
      return (
        opts.output ?? {
          message: { role: 'assistant', content: '答え' },
          stopReason: 'end_turn',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        }
      );
    },
    async *chatStream(input) {
      opts.capture?.(input);
      for (const c of opts.chunks ?? []) {
        yield c;
      }
    },
  };
}

test('generate: 完成テキストを返す', async () => {
  const client = new LlmAbstractionClient(() => fakeAdapter({}));
  const text = await client.generate({ model: 'm', messages: [{ role: 'user', content: 'q' }], requestId: 'r' });
  assert.equal(text, '答え');
});

test('generate: UnrecordedMessage を text 中心の Message へ写像（trace/llmType は落とす）', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.generate({
    model: 'mistral:7b',
    messages: [{ role: 'user', content: 'q', trace: 't', llmType: 'x' }],
    requestId: 'r',
  });
  assert.equal(captured?.model, 'mistral:7b');
  assert.deepEqual(captured?.messages, [{ role: 'user', content: 'q' }]);
});

// ── 添付（extraData）の取り込み ──────────────────────────────────────────────
// 「添付が無い呼び出し（predictTitle / RAG / Code Interpreter / 法令 RAG / 判定）は
//   モデルへ渡る messages が今と1バイトも変わらない」を固定する回帰テスト。

test('回帰: extraData が無ければ messages は content そのまま（1バイトも変えない）', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  const messages = [
    { role: 'system' as const, content: 'あなたは要約器です' },
    { role: 'user' as const, content: '次を3語で: 源内' },
    { role: 'assistant' as const, content: '源内・ローカル・API' },
  ];
  await client.generate({ model: 'm', messages, requestId: 'r' });
  assert.deepEqual(
    captured?.messages,
    messages.map((m) => ({ role: m.role, content: m.content })),
  );
});

test('回帰: extraData が空配列でも messages は変わらない', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.generate({
    model: 'm',
    messages: [{ role: 'user', content: 'q', extraData: [] }],
    requestId: 'r',
  });
  assert.deepEqual(captured?.messages, [{ role: 'user', content: 'q' }]);
});

test('回帰: generateStream でも extraData が無ければ messages は変わらない', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() =>
    fakeAdapter({ capture: (i) => (captured = i), chunks: [{ type: 'text_delta', text: 'a' }] }),
  );
  for await (const _ of client.generateStream({
    model: 'm',
    messages: [{ role: 'user', content: 'q' }],
    requestId: 'r',
  })) {
    // 反復して初めてアダプタが呼ばれる
  }
  assert.deepEqual(captured?.messages, [{ role: 'user', content: 'q' }]);
});

test('generate: extraData があれば documents ブロックを本文の前に置く', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.generate({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: 'この資料を要約して',
        extraData: [
          {
            type: 'file',
            name: 'memo.txt',
            source: {
              type: 'base64',
              mediaType: 'text/plain',
              data: Buffer.from('源内はローカルで動く。', 'utf8').toString('base64'),
            },
          },
        ],
      },
    ],
    requestId: 'r',
  });
  const content = captured?.messages[0]?.content as string;
  assert.ok(content.startsWith(ATTACHMENT_PREAMBLE), '注意書きが先頭');
  assert.ok(content.includes('<documents>'));
  assert.ok(content.includes('源内はローカルで動く。'), '取り出した中身が入る');
  assert.ok(content.endsWith('この資料を要約して'), '本文は documents の後ろ');
});

test('generate: 添付のあるメッセージだけに documents が付く（履歴の他のメッセージは無変化）', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.generate({
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: 'q1',
        extraData: [
          {
            type: 'file',
            name: 'a.txt',
            source: { type: 'base64', mediaType: 'text/plain', data: Buffer.from('AAA').toString('base64') },
          },
        ],
      },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
    requestId: 'r',
  });
  assert.equal(captured?.messages[0]?.content, 'sys');
  assert.ok((captured?.messages[1]?.content as string).includes('<documents>'));
  assert.equal(captured?.messages[2]?.content, 'a1');
  assert.equal(captured?.messages[3]?.content, 'q2');
});

test('generate: 文字数の合計はリクエスト全体で数える（古い添付は skipped）', async () => {
  // ATTACHMENT_TOTAL_MAX_CHARS は env（既定 5000）。1件の上限も同じ 5000 なので、
  // 5000 字の添付を2つ載せると、新しい方だけが本文として入り、古い方は注記になる。
  const big = (name: string) => ({
    type: 'file' as const,
    name,
    source: {
      type: 'base64' as const,
      mediaType: 'text/plain',
      data: Buffer.from('あ'.repeat(5000), 'utf8').toString('base64'),
    },
  });
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.generate({
    model: 'm',
    messages: [
      { role: 'user', content: 'q1', extraData: [big('old.txt')] },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2', extraData: [big('new.txt')] },
    ],
    requestId: 'r',
  });
  const oldMsg = captured?.messages[0]?.content as string;
  const newMsg = captured?.messages[2]?.content as string;
  assert.ok(newMsg.includes('あ'.repeat(100)), '最新の添付は本文が入る');
  assert.ok(oldMsg.includes('status="skipped"'), '古い添付は注記になる');
  assert.ok(!oldMsg.includes('あ'.repeat(100)), '古い添付の本文は渡さない');
});

test('generateStream: text_delta のみを文字列で yield（message_stop/usage は無視）', async () => {
  const client = new LlmAbstractionClient(() =>
    fakeAdapter({
      chunks: [
        { type: 'text_delta', text: 'あ' },
        { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } },
        { type: 'text_delta', text: 'い' },
        { type: 'message_stop', stopReason: 'end_turn' },
      ],
    }),
  );
  const tokens: string[] = [];
  for await (const t of client.generateStream({ model: 'm', messages: [], requestId: 'r' })) {
    tokens.push(t);
  }
  assert.deepEqual(tokens, ['あ', 'い']);
});

test('generateStream: error チャンクは throw する', async () => {
  const boom = new Error('backend down');
  const client = new LlmAbstractionClient(() =>
    fakeAdapter({ chunks: [{ type: 'error', error: boom as never }] }),
  );
  await assert.rejects(async () => {
    for await (const _ of client.generateStream({ model: 'm', messages: [], requestId: 'r' })) {
      // 反復で error チャンクに達した時点で throw される
    }
  });
});

test('adapter は lazy 生成（複数呼び出しでも factory は 1 回）', async () => {
  let built = 0;
  const client = new LlmAbstractionClient(() => {
    built += 1;
    return fakeAdapter({});
  });
  await client.generate({ model: 'm', messages: [], requestId: 'r1' });
  await client.generate({ model: 'm', messages: [], requestId: 'r2' });
  assert.equal(built, 1);
});

// ── 画像 ────────────────────────────────────────────────────────────────────

/** 本物の PNG の先頭（magic ＋ IHDR）。api は中身を見て形式を判定するため、偽のバイト列では通らない。 */
function pngBase64(width = 8, height = 8): string {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return Buffer.from(b).toString('base64');
}

const pngExtra = (name: string) => ({
  type: 'image' as const,
  name,
  source: { type: 'base64' as const, mediaType: 'image/png', data: pngBase64() },
});

test('画像: 経路が対応していれば image ブロックを content に載せる（資料→画像→質問の順）', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() =>
    fakeAdapter({ capture: (i) => (captured = i), supportsImages: true }),
  );
  await client.generate({
    model: 'm',
    messages: [{ role: 'user', content: 'これは何の画像？', extraData: [pngExtra('shot.png')] }],
    requestId: 'r',
  });
  const content = captured?.messages[0]?.content;
  assert.ok(Array.isArray(content), 'content は ContentBlock[] になる');
  const blocks = content as { type: string; text?: string; mediaType?: string; data?: string }[];
  assert.equal(blocks[0]?.type, 'text', '先頭は資料（documents）');
  assert.ok(blocks[0]?.text?.includes('status="image"'));
  assert.equal(blocks[1]?.type, 'image');
  assert.equal(blocks[1]?.mediaType, 'image/png');
  assert.equal(blocks[1]?.data, pngBase64());
  assert.equal(blocks[2]?.type, 'text');
  assert.equal(blocks[2]?.text, 'これは何の画像？', '質問は末尾');
});

test('画像: 経路が対応していなければ content は文字列のまま＋注記（黙って落とさない）', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() => fakeAdapter({ capture: (i) => (captured = i) }));
  await client.generate({
    model: 'm',
    messages: [{ role: 'user', content: 'これは何の画像？', extraData: [pngExtra('shot.png')] }],
    requestId: 'r',
  });
  const content = captured?.messages[0]?.content;
  assert.equal(typeof content, 'string');
  assert.ok((content as string).includes('status="unsupported"'));
  assert.ok((content as string).includes('この経路のモデルには画像を渡せません。'));
});

test('画像: 添付が画像だけでも質問は content の末尾に残る', async () => {
  let captured: ChatInput | undefined;
  const client = new LlmAbstractionClient(() =>
    fakeAdapter({ capture: (i) => (captured = i), supportsImages: true }),
  );
  await client.generate({
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q', extraData: [pngExtra('a.png'), pngExtra('b.png')] },
    ],
    requestId: 'r',
  });
  assert.equal(captured?.messages[0]?.content, 'sys', '添付の無いメッセージは文字列のまま');
  const blocks = captured?.messages[1]?.content as { type: string }[];
  assert.equal(blocks.filter((b) => b.type === 'image').length, 2);
  assert.equal(blocks[blocks.length - 1]?.type, 'text');
});

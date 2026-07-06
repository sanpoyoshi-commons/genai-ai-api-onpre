import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import type { EmbeddingClient } from '../../src/lib/llm/embeddingClient.js';
import type { LlmClient, LlmGenerateInput } from '../../src/lib/llm/llmClient.js';
import type { RagConfig } from '../../src/lib/rag/config.js';
import { RagService } from '../../src/lib/rag/ragService.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createRagRouter } from '../../src/routes/rag/index.js';
import type {
  ChunkInsert,
  ChunkRecord,
  RagRepositoryLike,
  SearchHit,
} from '../../src/repositories/ragRepository.js';

const config: RagConfig = {
  chunk: { maxChunkSize: 1000, chunkOverlap: 0, separators: ['\n\n', '\n', '。', '、', ' ', ''] },
  rrf: { k: 60, topM: 10 },
  fetchK: 20,
  bigmSimilarityLimit: 0.2,
  rerank: { enabled: false, candidates: 20 },
};

const fakeEmbedding: EmbeddingClient = {
  async embed(input) {
    return {
      embeddings: input.input.map(() => [0.1, 0.2]),
      model: 'ruri',
      usage: { promptTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    };
  },
};

class FakeRepo implements RagRepositoryLike {
  inserted: ChunkInsert[] = [];
  vectorHits: SearchHit[] = [];
  bigmHits: SearchHit[] = [];
  records: ChunkRecord[] = [];
  async createDocument(): Promise<string> {
    return 'doc1';
  }
  async insertChunks(_documentId: string, _ownerUserId: string, chunks: ChunkInsert[]): Promise<void> {
    this.inserted.push(...chunks);
  }
  async deleteDocument(): Promise<void> {
    /* 補償用。本テストでは未使用。 */
  }
  async vectorSearch(): Promise<SearchHit[]> {
    return this.vectorHits;
  }
  async bigmSearch(): Promise<SearchHit[]> {
    return this.bigmHits;
  }
  async getChunksByIds(_ownerUserId: string, ids: string[]): Promise<ChunkRecord[]> {
    return ids
      .map((id) => this.records.find((r) => r.id === id))
      .filter((r): r is ChunkRecord => r !== undefined);
  }
}

let llmResponse = '';
let lastGenerate: LlmGenerateInput | undefined;
const fakeLlm: LlmClient = {
  async generate(input: LlmGenerateInput): Promise<string> {
    lastGenerate = input;
    return llmResponse;
  },
  async *generateStream(): AsyncIterable<string> {
    /* unused */
  },
};

let repo: FakeRepo;
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
  repo = new FakeRepo();
  const rag = new RagService({ embedding: fakeEmbedding, repo, config });
  app.use('/api', createRagRouter({ rag, llm: fakeLlm }));
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
  repo.inserted = [];
  repo.vectorHits = [];
  repo.bigmHits = [];
  repo.records = [];
  llmResponse = '';
  lastGenerate = undefined;
  delete process.env.MODEL_IDS;
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

test('ingest: 文書を取り込み documentId と chunkCount を返す', async () => {
  const res = await api('/rag/documents', {
    method: 'POST',
    body: JSON.stringify({ title: 't', text: '# A\n本文A\n## B\n本文B' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { documentId: 'doc1', chunkCount: 2 });
  assert.equal(repo.inserted.length, 2);
});

test('ingest: text 欠落は 400', async () => {
  const res = await api('/rag/documents', {
    method: 'POST',
    body: JSON.stringify({ title: 't' }),
  });
  assert.equal(res.status, 400);
});

test('query: retrieve-and-generate＝{outputs, usageMetadata} を返し参照を連結', async () => {
  repo.vectorHits = [{ id: 'c1', score: 0.9 }];
  repo.bigmHits = [{ id: 'c1', score: 0.5 }];
  repo.records = [
    { id: 'c1', documentId: 'd', documentTitle: '社内規程', chunkText: '本文', headerPath: '第1章' },
  ];
  llmResponse = '回答本体 [1]';

  const res = await api('/rag/query', {
    method: 'POST',
    body: JSON.stringify({ inputs: { question: '休暇は？' } }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { outputs: string; usageMetadata: unknown[] };
  assert.match(body.outputs, /回答本体/);
  assert.match(body.outputs, /参考情報/);
  assert.match(body.outputs, /社内規程 \/ 第1章/);
  assert.deepEqual(body.usageMetadata, []);
  // LLM へ参考情報付き user メッセージが渡る。
  assert.equal(lastGenerate?.messages.length, 2);
  assert.match(lastGenerate?.messages[1]?.content ?? '', /本文/);
});

test('query: チャンク無しでも回答を返す（参考情報節なし）', async () => {
  llmResponse = '一般的な回答';
  const res = await api('/rag/query', {
    method: 'POST',
    body: JSON.stringify({ inputs: { question: 'q' } }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { outputs: string };
  assert.equal(body.outputs, '一般的な回答');
});

test('query: question 欠落は 400', async () => {
  const res = await api('/rag/query', {
    method: 'POST',
    body: JSON.stringify({ inputs: {} }),
  });
  assert.equal(res.status, 400);
});

test('query: 許可リスト外モデルは 400', async () => {
  process.env.MODEL_IDS = JSON.stringify(['allowed']);
  const res = await api('/rag/query', {
    method: 'POST',
    body: JSON.stringify({ inputs: { question: 'q' }, model: { modelId: 'forbidden' } }),
  });
  assert.equal(res.status, 400);
});

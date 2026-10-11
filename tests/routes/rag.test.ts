import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import type { AuthContext } from '../../src/lib/auth/context.js';
import { USER_GROUP } from '../../src/lib/auth/groups.js';
import { errorHandler } from '../../src/lib/http/createApiHandler.js';
import { KNOWLEDGE_LIMIT_DEFAULTS, type KnowledgeLimits } from '../../src/lib/knowledge/config.js';
import type { EmbeddingClient } from '../../src/lib/llm/embeddingClient.js';
import type { LlmClient, LlmGenerateInput } from '../../src/lib/llm/llmClient.js';
import type { RagConfig } from '../../src/lib/rag/config.js';
import { RagService } from '../../src/lib/rag/ragService.js';
import type { FileStorage } from '../../src/lib/storage/fileStorage.js';
import { requestContext } from '../../src/middleware/requestContext.js';
import { createRagRouter } from '../../src/routes/rag/index.js';
import { ingestMeasurement } from '../../src/routes/rag/knowledgeDocuments.js';
import {
  CollectionNameConflictError,
  type ChunkInsert,
  type ChunkProvenance,
  type ChunkRecord,
  type CollectionRecord,
  type DocumentInsert,
  type DocumentOwnership,
  type DocumentSummary,
  type KnowledgeRepositoryLike,
  type RagRepositoryLike,
  type SearchHit,
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
      model: 'ruri-test',
      usage: { promptTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    };
  },
};

/** 文書とチャンクとナレッジ集をメモリに持つ fake（実装と同じく 2 つの契約を 1 つで満たす）。 */
class FakeStore implements RagRepositoryLike, KnowledgeRepositoryLike {
  collections: Array<CollectionRecord & { ownerUserId: string }> = [];
  documents: Array<DocumentInsert & { id: string; createdAt: Date; updatedAt: Date }> = [];
  chunks: Array<{ documentId: string; ownerUserId: string } & ChunkInsert> = [];
  provenance: ChunkProvenance | undefined;
  vectorHits: SearchHit[] = [];
  bigmHits: SearchHit[] = [];
  records: ChunkRecord[] = [];
  searchArgs: Array<{ collectionIds?: string[]; limit: number }> = [];
  private seq = 0;

  /** router が握る参照を保ったまま中身を空に戻す（各テストの前に呼ぶ）。 */
  reset(): void {
    this.collections = [];
    this.documents = [];
    this.chunks = [];
    this.provenance = undefined;
    this.vectorHits = [];
    this.bigmHits = [];
    this.records = [];
    this.searchArgs = [];
    this.seq = 0;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  // ── ナレッジ集 ──
  async createCollection(input: {
    ownerUserId: string;
    name: string;
    description?: string;
  }): Promise<CollectionRecord> {
    if (this.collections.some((c) => c.ownerUserId === input.ownerUserId && c.name === input.name)) {
      throw new CollectionNameConflictError(input.name);
    }
    const now = new Date('2026-10-10T00:00:00Z');
    const created = {
      id: this.nextId('col'),
      ownerUserId: input.ownerUserId,
      name: input.name,
      description: input.description ?? null,
      mcpEnabled: false,
      documentCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.collections.push(created);
    return created;
  }

  private withCount(c: CollectionRecord & { ownerUserId: string }): CollectionRecord {
    return {
      ...c,
      documentCount: this.documents.filter((d) => d.collectionId === c.id).length,
    };
  }

  async listCollections(ownerUserId: string): Promise<CollectionRecord[]> {
    return this.collections.filter((c) => c.ownerUserId === ownerUserId).map((c) => this.withCount(c));
  }

  async getCollection(ownerUserId: string, collectionId: string): Promise<CollectionRecord | undefined> {
    const found = this.collections.find((c) => c.id === collectionId && c.ownerUserId === ownerUserId);
    return found ? this.withCount(found) : undefined;
  }

  async updateCollection(
    ownerUserId: string,
    collectionId: string,
    patch: { name?: string; description?: string },
  ): Promise<CollectionRecord | undefined> {
    const found = this.collections.find((c) => c.id === collectionId && c.ownerUserId === ownerUserId);
    if (!found) {
      return undefined;
    }
    if (
      patch.name !== undefined &&
      this.collections.some(
        (c) => c.ownerUserId === ownerUserId && c.name === patch.name && c.id !== collectionId,
      )
    ) {
      throw new CollectionNameConflictError(patch.name);
    }
    if (patch.name !== undefined) {
      found.name = patch.name;
    }
    if (patch.description !== undefined) {
      found.description = patch.description;
    }
    return this.withCount(found);
  }

  async deleteCollection(ownerUserId: string, collectionId: string): Promise<string[] | undefined> {
    const index = this.collections.findIndex(
      (c) => c.id === collectionId && c.ownerUserId === ownerUserId,
    );
    if (index < 0) {
      return undefined;
    }
    this.collections.splice(index, 1);
    const removed = this.documents.filter((d) => d.collectionId === collectionId);
    for (const doc of removed) {
      this.removeDocument(doc.id);
    }
    return removed.map((d) => d.bronzeKey).filter((k): k is string => k !== undefined);
  }

  async ensureDefaultCollection(ownerUserId: string): Promise<string> {
    const existing = this.collections.find((c) => c.ownerUserId === ownerUserId && c.name === '未分類');
    if (existing) {
      return existing.id;
    }
    const created = await this.createCollection({ ownerUserId, name: '未分類' });
    return created.id;
  }

  async filterOwnedCollectionIds(ownerUserId: string, collectionIds: string[]): Promise<string[]> {
    return this.collections
      .filter((c) => c.ownerUserId === ownerUserId && collectionIds.includes(c.id))
      .map((c) => c.id);
  }

  // ── 文書 ──
  async createDocument(input: DocumentInsert): Promise<string> {
    const id = this.nextId('doc');
    const now = new Date('2026-10-10T00:00:00Z');
    this.documents.push({ ...input, id, createdAt: now, updatedAt: now });
    return id;
  }

  async listDocuments(ownerUserId: string, collectionId: string): Promise<DocumentSummary[]> {
    return this.documents
      .filter((d) => d.ownerUserId === ownerUserId && d.collectionId === collectionId)
      .map((d) => ({
        id: d.id,
        collectionId: d.collectionId,
        title: d.title,
        mime: d.mime ?? null,
        originalFilename: d.originalFilename ?? null,
        byteSize: d.byteSize ?? null,
        charCount: d.charCount ?? null,
        chunkCount: this.chunks.filter((c) => c.documentId === d.id).length,
        extractor: d.extractor ?? null,
        extractorVersion: d.extractorVersion ?? null,
        status: d.status ?? 'ready',
        error: d.error ?? null,
        hasBronze: d.bronzeKey !== undefined && d.bronzeKey !== '',
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }));
  }

  async isBronzeKeyUsed(ownerUserId: string, bronzeKey: string): Promise<boolean> {
    return this.documents.some((d) => d.ownerUserId === ownerUserId && d.bronzeKey === bronzeKey);
  }

  async getDocument(ownerUserId: string, documentId: string): Promise<DocumentOwnership | undefined> {
    const found = this.documents.find((d) => d.id === documentId && d.ownerUserId === ownerUserId);
    return found
      ? { id: found.id, collectionId: found.collectionId, bronzeKey: found.bronzeKey ?? null }
      : undefined;
  }

  private removeDocument(documentId: string): void {
    this.documents = this.documents.filter((d) => d.id !== documentId);
    this.chunks = this.chunks.filter((c) => c.documentId !== documentId);
  }

  async deleteDocument(documentId: string, ownerUserId: string): Promise<void> {
    if (this.documents.some((d) => d.id === documentId && d.ownerUserId === ownerUserId)) {
      this.removeDocument(documentId);
    }
  }

  // ── チャンク ──
  async insertChunks(
    documentId: string,
    ownerUserId: string,
    chunks: ChunkInsert[],
    provenance?: ChunkProvenance,
  ): Promise<void> {
    this.provenance = provenance;
    for (const c of chunks) {
      this.chunks.push({ documentId, ownerUserId, ...c });
    }
  }

  async vectorSearch(
    _ownerUserId: string,
    _vec: number[],
    limit: number,
    collectionIds?: string[],
  ): Promise<SearchHit[]> {
    this.searchArgs.push({ collectionIds, limit });
    return this.vectorHits;
  }

  async bigmSearch(
    _ownerUserId: string,
    _query: string,
    _limit: number,
    _similarityLimit: number,
    _collectionIds?: string[],
  ): Promise<SearchHit[]> {
    return this.bigmHits;
  }

  async getChunksByIds(_ownerUserId: string, ids: string[]): Promise<ChunkRecord[]> {
    return ids
      .map((id) => this.records.find((r) => r.id === id))
      .filter((r): r is ChunkRecord => r !== undefined);
  }
}

/** 原本（Bronze）の置き場の fake。 */
class FakeStorage implements FileStorage {
  objects = new Map<string, Uint8Array>();
  deleteFailures = new Set<string>();

  async presignUpload(bucket: string, key: string): Promise<string> {
    return `https://storage.test/${bucket}/${key}?signed=1`;
  }
  async presignDownload(bucket: string, key: string): Promise<string> {
    return `https://storage.test/${bucket}/${key}?signed=1`;
  }
  async getObject(_bucket: string, key: string): Promise<Uint8Array> {
    const found = this.objects.get(key);
    if (!found) {
      throw new Error('NoSuchKey');
    }
    return found;
  }
  async putObject(_bucket: string, key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }
  async deleteObject(_bucket: string, key: string): Promise<void> {
    if (this.deleteFailures.has(key)) {
      throw new Error('delete failed');
    }
    this.objects.delete(key);
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

let store: FakeStore;
let storage: FakeStorage;
let limits: KnowledgeLimits;
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
  store = new FakeStore();
  storage = new FakeStorage();
  limits = { ...KNOWLEDGE_LIMIT_DEFAULTS };
  const rag = new RagService({ embedding: fakeEmbedding, repo: store, config });
  app.use(
    '/api',
    createRagRouter({
      rag,
      llm: fakeLlm,
      knowledge: store,
      storage,
      buckets: { knowledgeBucket: 'genai-knowledge' },
      // router は deps を握り続けるので、上限は同じ入れ物の中身を書き替えて差し替える。
      limits,
    }),
  );
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
  store.reset();
  storage.objects.clear();
  storage.deleteFailures.clear();
  Object.assign(limits, KNOWLEDGE_LIMIT_DEFAULTS);
  llmResponse = '';
  lastGenerate = undefined;
  delete process.env.MODEL_IDS;
  currentAuth = { userId: 'u1', groups: [USER_GROUP], claims: {} };
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init });

const post = (path: string, body: unknown) =>
  api(path, { method: 'POST', body: JSON.stringify(body) });

/** テスト用に 1 つナレッジ集を作る。 */
const makeCollection = async (ownerUserId: string, name: string): Promise<string> => {
  const created = await store.createCollection({ ownerUserId, name });
  return created.id;
};

// ── ナレッジ集 ──────────────────────────────────────────

test('collections: 作成して一覧に出る', async () => {
  const created = await post('/rag/collections', { name: 'テストA', description: '説明' });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { collectionId: string; name: string };
  assert.equal(body.name, 'テストA');

  const listed = await api('/rag/collections');
  assert.equal(listed.status, 200);
  const list = (await listed.json()) as { collections: Array<{ name: string; mcpEnabled: boolean }> };
  assert.equal(list.collections.length, 1);
  assert.equal(list.collections[0]?.name, 'テストA');
  // 外部のエージェントへ開く印は、切り替えの口ができるまで必ず false で作る。
  assert.equal(list.collections[0]?.mcpEnabled, false);
});

test('collections: 同じ名前は 409', async () => {
  await post('/rag/collections', { name: 'テストA' });
  const again = await post('/rag/collections', { name: 'テストA' });
  assert.equal(again.status, 409);
});

test('collections: 一覧は自分のものだけ（他人のものは出ない）', async () => {
  await makeCollection('other', '他人の集');
  const listed = await api('/rag/collections');
  const list = (await listed.json()) as { collections: unknown[] };
  assert.deepEqual(list.collections, []);
});

test('collections: 名前の変更', async () => {
  const id = await makeCollection('u1', 'テストA');
  const res = await api(`/rag/collections/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'テストB' }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { name: string }).name, 'テストB');
});

test('collections: 他人のナレッジ集は 404（名前の変更・削除・一覧・投入のすべて）', async () => {
  const foreign = await makeCollection('other', '他人の集');

  const renamed = await api(`/rag/collections/${foreign}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '乗っ取り' }),
  });
  assert.equal(renamed.status, 404);

  const removed = await api(`/rag/collections/${foreign}`, { method: 'DELETE' });
  assert.equal(removed.status, 404);

  const listed = await api(`/rag/collections/${foreign}/documents`);
  assert.equal(listed.status, 404);

  const ingested = await post(`/rag/collections/${foreign}/documents`, {
    title: 't',
    text: '本文',
  });
  assert.equal(ingested.status, 404);

  const upload = await post(`/rag/collections/${foreign}/uploads`, { filename: 'a.txt' });
  assert.equal(upload.status, 404);

  // 他人のナレッジ集は名前を変えられていない。
  assert.equal(store.collections.find((c) => c.id === foreign)?.name, '他人の集');
});

// ── 投入（同期・上限つき）──────────────────────────────

test('ingest: 貼り付けたテキストは原本としても保存され、3 層がそろう', async () => {
  const id = await makeCollection('u1', 'テストA');
  const res = await post(`/rag/collections/${id}/documents`, {
    title: 'メモ',
    text: '# A\n本文A\n## B\n本文B',
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    documentId: string;
    chunkCount: number;
    charCount: number;
    status: string;
    mime: string;
  };
  assert.equal(body.status, 'ready');
  assert.equal(body.chunkCount, 2);
  assert.ok(body.charCount > 0);
  assert.equal(body.mime, 'text/plain');

  // Bronze＝オブジェクト（キーの先頭は所有者）。
  const keys = [...storage.objects.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0]?.startsWith('u1/'));
  // Silver＝抽出テキストと抽出器の版。
  const document = store.documents.find((d) => d.id === body.documentId);
  assert.equal(document?.silverText, '# A\n本文A\n## B\n本文B');
  assert.equal(document?.extractor, 'text-decode');
  assert.ok(document?.sha256 && document.sha256.length === 64);
  // Gold＝チャンクに切り方の設定と埋め込みモデルが残る。
  assert.equal(store.chunks.filter((c) => c.documentId === body.documentId).length, 2);
  assert.equal(store.provenance?.embeddingModel, 'ruri-test');
  assert.deepEqual(store.provenance?.chunkerConfig, config.chunk);
});

test('ingest: 上げた原本をキーで読み込む（一覧に文字数とチャンク数が出る）', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/11111111-1111-1111-1111-111111111111/note.md';
  storage.objects.set(key, new Uint8Array(Buffer.from('# 見出し\n本文です。', 'utf8')));

  const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { title: string; mime: string };
  // title 未指定なら元のファイル名。
  assert.equal(body.title, 'note.md');
  assert.equal(body.mime, 'text/markdown');

  const listed = await api(`/rag/collections/${id}/documents`);
  const list = (await listed.json()) as {
    documents: Array<{ charCount: number; chunkCount: number; hasBronze: boolean }>;
  };
  assert.equal(list.documents.length, 1);
  assert.ok((list.documents[0]?.charCount ?? 0) > 0);
  assert.ok((list.documents[0]?.chunkCount ?? 0) > 0);
  assert.equal(list.documents[0]?.hasBronze, true);
});

test('ingest: pdf でもバイト数が記録される（抽出器がバイト列を接収しても測り損じない）', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/ja.pdf';
  const pdf = new Uint8Array(
    readFileSync(new URL('../fixtures/attachments/ja-cid.pdf', import.meta.url)),
  );
  const byteSize = pdf.byteLength;
  storage.objects.set(key, pdf);

  const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { byteSize: number; mime: string; documentId: string };
  // pdfjs は渡したバイト列の持ち主になる。抽出の後に数えると 0 になるため、先に測る。
  assert.equal(body.byteSize, byteSize);
  assert.equal(body.mime, 'application/pdf');
  assert.equal(store.documents.find((d) => d.id === body.documentId)?.extractor, 'pdfjs-dist');
});

test('ingest: 同じ原本を 2 回取り込ませない（1 件目の原本を消さない）', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/cccccccc-cccc-cccc-cccc-cccccccccccc/note.md';
  storage.objects.set(key, new Uint8Array(Buffer.from('# A\n本文A', 'utf8')));
  assert.equal((await post(`/rag/collections/${id}/documents`, { bronzeKey: key })).status, 201);

  // 2 件目は断る。断ったときは原本を消す規則なので、入口で止めないと 1 件目の原本が消える。
  Object.assign(limits, { maxChunks: 0 });
  const again = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  assert.equal(again.status, 400);
  assert.match(((await again.json()) as { error: string }).error, /すでに取り込まれています/);
  assert.equal(store.documents.length, 1);
  assert.ok(storage.objects.has(key));
});

test('ingest: 他人のキーを渡しても読まない（404・原本は消さない）', async () => {
  const id = await makeCollection('u1', 'テストA');
  const foreignKey = 'other/22222222-2222-2222-2222-222222222222/secret.txt';
  storage.objects.set(foreignKey, new Uint8Array(Buffer.from('ひみつ', 'utf8')));

  const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: foreignKey });
  assert.equal(res.status, 404);
  assert.equal(store.documents.length, 0);
  // 他人の原本に触れていない。
  assert.ok(storage.objects.has(foreignKey));
});

test('ingest: 所有者のプレフィックスから抜け出すキーは断る', async () => {
  const id = await makeCollection('u1', 'テストA');
  for (const key of ['u1/../other/x.txt', 'u1', 'u1/x.txt', 'u1//x.txt']) {
    const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
    assert.equal(res.status, 404, key);
  }
});

test('ingest: チャンク数の上限を超えたら断り、文書も原本も作らない', async () => {
  const id = await makeCollection('u1', 'テストA');
  Object.assign(limits, { maxChunks: 2 });
  const key = 'u1/33333333-3333-3333-3333-333333333333/big.md';
  // 見出しごとに 1 チャンク＝3 チャンクになる本文。
  storage.objects.set(key, new Uint8Array(Buffer.from('# A\nあ\n# B\nい\n# C\nう', 'utf8')));

  const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /チャンク/);
  assert.equal(store.documents.length, 0);
  assert.equal(store.chunks.length, 0);
  // 断ったときは原本も消す（置き場に迷子を残さない）。
  assert.equal(storage.objects.has(key), false);
});

test('ingest: 文字数の上限を超えたら切り詰めずに断る', async () => {
  const id = await makeCollection('u1', 'テストA');
  Object.assign(limits, { maxChars: 10 });
  const res = await post(`/rag/collections/${id}/documents`, {
    title: 'メモ',
    text: 'あ'.repeat(11),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /文字数/);
  assert.equal(store.documents.length, 0);
  assert.equal(storage.objects.size, 0);
});

test('ingest: 読めない形式は断る（画像は受け付けない）', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/44444444-4444-4444-4444-444444444444/photo.png';
  storage.objects.set(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  assert.equal(res.status, 400);
  assert.equal(store.documents.length, 0);
  assert.equal(storage.objects.has(key), false);
});

test('ingest: 拡張子と中身が食い違う原本は断る', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/55555555-5555-5555-5555-555555555555/fake.txt';
  // 中身は PDF なのに .txt と名乗る（文字化けを貯めない）。
  storage.objects.set(key, new Uint8Array(Buffer.from('%PDF-1.7\n...', 'utf8')));
  const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /拡張子と中身/);
});

test('ingest: 読める形式なのに文字が取れないものは failed で残し、原本は消さない', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/66666666-6666-6666-6666-666666666666/empty.txt';
  storage.objects.set(key, new Uint8Array(Buffer.from('   \n  ', 'utf8')));

  const res = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; error: string; documentId: string };
  assert.equal(body.status, 'failed');
  assert.ok(body.error.length > 0);
  // 抽出器を良くしたときに作り直せるよう、原本は残す。
  assert.ok(storage.objects.has(key));
  assert.equal(store.chunks.length, 0);
});

// ── 検索だけ ────────────────────────────────────────────

test('search: チャンク・スコア・文書名を返す', async () => {
  store.vectorHits = [{ id: 'c1', score: 0.9 }];
  store.bigmHits = [{ id: 'c1', score: 0.5 }];
  store.records = [
    {
      id: 'c1',
      documentId: 'd1',
      documentTitle: '社内規程',
      collectionId: 'col1',
      chunkIndex: 3,
      chunkText: '本文',
      headerPath: '第1章',
    },
  ];

  const res = await post('/rag/search', { query: '休暇' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    results: Array<{
      documentId: string;
      title: string;
      collectionId: string;
      chunkIndex: number;
      text: string;
      score: number;
      rerankScore?: number;
    }>;
  };
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]?.title, '社内規程');
  assert.equal(body.results[0]?.documentId, 'd1');
  assert.equal(body.results[0]?.collectionId, 'col1');
  assert.equal(body.results[0]?.chunkIndex, 3);
  assert.equal(body.results[0]?.text, '本文');
  assert.ok((body.results[0]?.score ?? 0) > 0);
  // rerank 無効のときはリランカのスコアを載せない。
  assert.equal(body.results[0]?.rerankScore, undefined);
});

test('search: 0 件は results: [] を返す（文章で「該当なし」と言わない）', async () => {
  const res = await post('/rag/search', { query: '当たらない語' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { results: [] });
});

test('search: collectionIds で絞ると、その id だけが検索に渡る', async () => {
  const id = await makeCollection('u1', 'テストB');
  const res = await post('/rag/search', { query: '休暇', collectionIds: [id] });
  assert.equal(res.status, 200);
  assert.deepEqual(store.searchArgs.at(-1)?.collectionIds, [id]);
});

test('search: 他人のナレッジ集を混ぜたら 404（絞り込みが黙って外れない）', async () => {
  const mine = await makeCollection('u1', 'テストA');
  const foreign = await makeCollection('other', '他人の集');
  const res = await post('/rag/search', { query: '休暇', collectionIds: [mine, foreign] });
  assert.equal(res.status, 404);
  assert.equal(store.searchArgs.length, 0);
});

test('search: query 欠落は 400', async () => {
  const res = await post('/rag/search', {});
  assert.equal(res.status, 400);
});

test('search: topK は上限を超えられない', async () => {
  const res = await post('/rag/search', { query: 'q', topK: 1000 });
  assert.equal(res.status, 400);
});

// ── 回答と参照を構造で返す ──────────────────────────────

test('ask: 回答と参照（番号・文書名・見出し・本文・スコア）を構造で返す', async () => {
  store.vectorHits = [
    { id: 'c1', score: 0.9 },
    { id: 'c2', score: 0.8 },
  ];
  store.records = [
    {
      id: 'c1',
      documentId: 'd1',
      documentTitle: '社内規程',
      collectionId: 'col1',
      chunkIndex: 3,
      chunkText: '本文1',
      headerPath: '第1章',
    },
    {
      id: 'c2',
      documentId: 'd2',
      documentTitle: '経理規程',
      collectionId: 'col1',
      chunkIndex: 0,
      chunkText: '本文2',
      headerPath: null,
    },
  ];
  llmResponse = '回答本体 [1] と [2]';

  const res = await post('/rag/ask', { question: '休暇は？' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    answer: string;
    references: Array<{
      n: number;
      documentId: string;
      title: string;
      collectionId: string;
      chunkIndex: number;
      headerPath: string | null;
      text: string;
      score: number;
      rerankScore?: number;
    }>;
  };
  // 回答には出典節を連結しない（画面が参照を組み立てる）。
  assert.equal(body.answer, '回答本体 [1] と [2]');
  assert.equal(body.answer.includes('参考情報'), false);
  assert.equal(body.references.length, 2);
  // 番号はプロンプトへ渡した並び順と同じ 1 起点。
  assert.deepEqual(
    body.references.map((r) => r.n),
    [1, 2],
  );
  assert.equal(body.references[0]?.title, '社内規程');
  assert.equal(body.references[0]?.headerPath, '第1章');
  assert.equal(body.references[0]?.chunkIndex, 3);
  assert.equal(body.references[0]?.text, '本文1');
  assert.ok((body.references[0]?.score ?? 0) > 0);
  assert.equal(body.references[1]?.headerPath, null);
  assert.equal(body.references[0]?.rerankScore, undefined);
});

test('ask: 検索も生成も /rag/query と同じ処理を通る（回答本体が一致する）', async () => {
  store.vectorHits = [{ id: 'c1', score: 0.9 }];
  store.records = [
    {
      id: 'c1',
      documentId: 'd1',
      documentTitle: '社内規程',
      collectionId: 'col1',
      chunkIndex: 0,
      chunkText: '本文',
      headerPath: null,
    },
  ];
  llmResponse = '同じ回答 [1]';

  const asked = (await (await post('/rag/ask', { question: 'q' })).json()) as { answer: string };
  const queried = (await (
    await post('/rag/query', { inputs: { question: 'q' } })
  ).json()) as { outputs: string };
  assert.equal(asked.answer, '同じ回答 [1]');
  // query 側は同じ回答に出典節を連結した形（上流契約）。
  assert.ok(queried.outputs.startsWith('同じ回答 [1]'));
  assert.match(queried.outputs, /参考情報/);
});

test('ask: チャンク無しでも参照は空配列（落ちない）', async () => {
  llmResponse = '一般的な回答';
  const res = await post('/rag/ask', { question: 'q' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { answer: '一般的な回答', references: [] });
});

test('ask: 他人のナレッジ集を混ぜたら 404（絞り込みが黙って外れない）', async () => {
  const mine = await makeCollection('u1', 'テストA');
  const foreign = await makeCollection('other', '他人の集');
  llmResponse = '回答';

  const ok = await post('/rag/ask', { question: 'q', collectionIds: [mine] });
  assert.equal(ok.status, 200);
  assert.deepEqual(store.searchArgs.at(-1)?.collectionIds, [mine]);

  const ng = await post('/rag/ask', { question: 'q', collectionIds: [mine, foreign] });
  assert.equal(ng.status, 404);
});

test('ask: question 欠落は 400／許可リスト外モデルは 400', async () => {
  assert.equal((await post('/rag/ask', {})).status, 400);
  process.env.MODEL_IDS = JSON.stringify(['allowed']);
  const res = await post('/rag/ask', { question: 'q', model: { modelId: 'forbidden' } });
  assert.equal(res.status, 400);
});

// ── 削除 ────────────────────────────────────────────────

test('delete document: 3 層（原本・抽出テキスト・チャンク）がそろって消える', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/77777777-7777-7777-7777-777777777777/note.md';
  storage.objects.set(key, new Uint8Array(Buffer.from('# A\n本文A', 'utf8')));
  const ingested = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  const { documentId } = (await ingested.json()) as { documentId: string };
  assert.equal(store.chunks.filter((c) => c.documentId === documentId).length, 1);

  const res = await api(`/rag/documents/${documentId}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(store.documents.length, 0);
  assert.equal(store.chunks.length, 0);
  assert.equal(storage.objects.has(key), false);
});

test('delete document: 他人の文書は 404（消えない）', async () => {
  const foreign = await makeCollection('other', '他人の集');
  const documentId = await store.createDocument({
    ownerUserId: 'other',
    collectionId: foreign,
    title: '他人の文書',
    bronzeKey: 'other/88888888-8888-8888-8888-888888888888/x.txt',
  });
  const res = await api(`/rag/documents/${documentId}`, { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.equal(store.documents.length, 1);
});

test('delete document: 原本の削除が失敗しても DB は消し、落ちない', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/99999999-9999-9999-9999-999999999999/note.md';
  storage.objects.set(key, new Uint8Array(Buffer.from('# A\n本文A', 'utf8')));
  const ingested = await post(`/rag/collections/${id}/documents`, { bronzeKey: key });
  const { documentId } = (await ingested.json()) as { documentId: string };
  storage.deleteFailures.add(key);

  const res = await api(`/rag/documents/${documentId}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(store.documents.length, 0);
  // 置き場に残ったものはログに任せる（取り残しを後から掃除する仕組みはまだ無い）。
  assert.ok(storage.objects.has(key));
});

test('delete collection: 中の文書も 3 層とも消える', async () => {
  const id = await makeCollection('u1', 'テストA');
  const key = 'u1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/note.md';
  storage.objects.set(key, new Uint8Array(Buffer.from('# A\n本文A', 'utf8')));
  await post(`/rag/collections/${id}/documents`, { bronzeKey: key });

  const res = await api(`/rag/collections/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(store.collections.length, 0);
  assert.equal(store.documents.length, 0);
  assert.equal(store.chunks.length, 0);
  assert.equal(storage.objects.has(key), false);
});

// ── 署名付き URL ────────────────────────────────────────

test('uploads: キーの先頭は所有者（クライアントに置き場を選ばせない）', async () => {
  const id = await makeCollection('u1', 'テストA');
  const res = await post(`/rag/collections/${id}/uploads`, { filename: '../../etc/passwd' });
  assert.equal(res.status, 200);
  const url = (await res.json()) as string;
  assert.ok(url.includes('/genai-knowledge/u1/'));
  assert.equal(url.includes('../'), false);
});

// ── 互換の経路と retrieve-and-generate ──────────────────

test('ingest（互換）: 文書を取り込み documentId と chunkCount を返す（既定のナレッジ集へ）', async () => {
  const res = await post('/rag/documents', { title: 't', text: '# A\n本文A\n## B\n本文B' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { documentId: string; chunkCount: number };
  assert.equal(body.chunkCount, 2);
  // 既定のナレッジ集が作られ、そこへ入る。原本は無い（作り直せない）。
  assert.equal(store.collections.length, 1);
  assert.equal(store.collections[0]?.name, '未分類');
  assert.equal(store.documents[0]?.bronzeKey, undefined);
});

test('ingest（互換）: text 欠落は 400', async () => {
  const res = await post('/rag/documents', { title: 't' });
  assert.equal(res.status, 400);
});

test('query: retrieve-and-generate＝{outputs, usageMetadata} を返し参照を連結', async () => {
  store.vectorHits = [{ id: 'c1', score: 0.9 }];
  store.bigmHits = [{ id: 'c1', score: 0.5 }];
  store.records = [
    {
      id: 'c1',
      documentId: 'd',
      documentTitle: '社内規程',
      collectionId: 'col1',
      chunkIndex: 0,
      chunkText: '本文',
      headerPath: '第1章',
    },
  ];
  llmResponse = '回答本体 [1]';

  const res = await post('/rag/query', { inputs: { question: '休暇は？' } });
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

test('query: collectionIds を任意で受ける（他人のものを混ぜたら 404）', async () => {
  const mine = await makeCollection('u1', 'テストA');
  llmResponse = '回答';
  const ok = await post('/rag/query', { inputs: { question: 'q' }, collectionIds: [mine] });
  assert.equal(ok.status, 200);
  assert.deepEqual(store.searchArgs.at(-1)?.collectionIds, [mine]);

  const foreign = await makeCollection('other', '他人の集');
  const ng = await post('/rag/query', { inputs: { question: 'q' }, collectionIds: [foreign] });
  assert.equal(ng.status, 404);
});

test('query: チャンク無しでも回答を返す（参考情報節なし）', async () => {
  llmResponse = '一般的な回答';
  const res = await post('/rag/query', { inputs: { question: 'q' } });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { outputs: string }).outputs, '一般的な回答');
});

test('query: question 欠落は 400', async () => {
  const res = await post('/rag/query', { inputs: {} });
  assert.equal(res.status, 400);
});

test('query: 許可リスト外モデルは 400', async () => {
  process.env.MODEL_IDS = JSON.stringify(['allowed']);
  const res = await post('/rag/query', {
    inputs: { question: 'q' },
    model: { modelId: 'forbidden' },
  });
  assert.equal(res.status, 400);
});

// ── 投入の実測のログ ────────────────────────────────────

test('ingestMeasurement: 1 行に出す項目（統合確認の台本が拾う）', () => {
  const line = ingestMeasurement({
    documentId: 'doc-1',
    mime: 'application/pdf',
    charCount: 176591,
    chunkCount: 300,
    extractMs: 940,
    embedMs: 262000,
  });
  assert.deepEqual(Object.keys(line).sort(), [
    'charCount',
    'chunkCount',
    'documentId',
    'embedMs',
    'extractMs',
    'mime',
  ]);
  assert.equal(line.chunkCount, 300);
  assert.equal(line.embedMs, 262000);
});

test('ingestMeasurement: 本文・原本のキー・ファイル名は載せない', () => {
  const line = ingestMeasurement({
    documentId: 'doc-1',
    mime: 'text/plain',
    charCount: 10,
    chunkCount: 1,
    extractMs: 1,
    embedMs: 2,
    // 呼び出し側が余分なものを渡しても、出す項目は増えない。
    ...({
      bronzeKey: 'u1/uuid/secret.pdf',
      originalFilename: 'secret.pdf',
      silverText: '取り込んだ本文',
    } as never),
  });
  const serialized = JSON.stringify(line);
  assert.equal(serialized.includes('bronzeKey'), false);
  assert.equal(serialized.includes('secret.pdf'), false);
  assert.equal(serialized.includes('取り込んだ本文'), false);
});

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { EmbeddingClient, EmbeddingInput } from '../../src/lib/llm/embeddingClient.js';
import type { RerankClient, RerankInput } from '../../src/lib/llm/rerankClient.js';
import { ChunkLimitExceededError, RagService } from '../../src/lib/rag/ragService.js';
import type { RagConfig } from '../../src/lib/rag/config.js';
import type {
  ChunkInsert,
  ChunkProvenance,
  ChunkRecord,
  DocumentInsert,
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

// ── fake embedding（input ごとに 1 ベクトルを返す＋入力捕捉） ──
let embedCalls: EmbeddingInput[] = [];
const fakeEmbedding: EmbeddingClient = {
  async embed(input) {
    embedCalls.push(input);
    return {
      embeddings: input.input.map((_, i) => [0.1 + i, 0.2]),
      model: 'ruri',
      usage: { promptTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    };
  },
};

// ── fake repo（呼び出し記録＋プリセット応答） ──
class FakeRepo implements RagRepositoryLike {
  created: DocumentInsert[] = [];
  inserted: Array<{
    documentId: string;
    ownerUserId: string;
    chunks: ChunkInsert[];
    provenance?: ChunkProvenance;
  }> = [];
  deleted: Array<{ documentId: string; ownerUserId: string }> = [];
  insertChunksError: Error | null = null;
  vectorArgs: Array<{ ownerUserId: string; limit: number; collectionIds?: string[] }> = [];
  bigmArgs: Array<{
    ownerUserId: string;
    query: string;
    limit: number;
    similarityLimit: number;
    collectionIds?: string[];
  }> = [];
  vectorHits: SearchHit[] = [];
  bigmHits: SearchHit[] = [];
  records: ChunkRecord[] = [];

  async createDocument(input: DocumentInsert): Promise<string> {
    this.created.push(input);
    return 'doc1';
  }
  async insertChunks(
    documentId: string,
    ownerUserId: string,
    chunks: ChunkInsert[],
    provenance?: ChunkProvenance,
  ): Promise<void> {
    if (this.insertChunksError) {
      throw this.insertChunksError;
    }
    this.inserted.push({ documentId, ownerUserId, chunks, provenance });
  }
  async deleteDocument(documentId: string, ownerUserId: string): Promise<void> {
    this.deleted.push({ documentId, ownerUserId });
  }
  async vectorSearch(
    ownerUserId: string,
    _vec: number[],
    limit: number,
    collectionIds?: string[],
  ): Promise<SearchHit[]> {
    this.vectorArgs.push({ ownerUserId, limit, collectionIds });
    return this.vectorHits;
  }
  async bigmSearch(
    ownerUserId: string,
    query: string,
    limit: number,
    similarityLimit: number,
    collectionIds?: string[],
  ): Promise<SearchHit[]> {
    this.bigmArgs.push({ ownerUserId, query, limit, similarityLimit, collectionIds });
    return this.bigmHits;
  }
  async getChunksByIds(_ownerUserId: string, ids: string[]): Promise<ChunkRecord[]> {
    // 順不同を模すため逆順で返す（service が RRF 順へ並べ替えることの検証）。
    return ids
      .map((id) => this.records.find((r) => r.id === id))
      .filter((r): r is ChunkRecord => r !== undefined)
      .reverse();
  }
}

let repo: FakeRepo;
beforeEach(() => {
  embedCalls = [];
  repo = new FakeRepo();
});

test('ingest: チャンク化→本文全体 embedding→格納（embeddings がチャンクに整列）', async () => {
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  const result = await svc.ingest(
    'u1',
    { document: { collectionId: 'c1', title: 't' }, text: '# A\n本文A\n## B\n本文B' },
    'r1',
  );

  assert.equal(result.documentId, 'doc1');
  assert.equal(result.chunkCount, 2);
  // embed は全チャンク本文を 1 回でまとめて投げる。
  assert.equal(embedCalls.length, 1);
  assert.deepEqual(embedCalls[0]?.input, ['本文A', '本文B']);
  assert.equal(embedCalls[0]?.requestId, 'r1');
  // 格納は documentId/ownerUserId＋整列 embedding。
  assert.equal(repo.created.length, 1);
  assert.deepEqual(repo.created[0], { ownerUserId: 'u1', collectionId: 'c1', title: 't' });
  assert.equal(repo.inserted.length, 1);
  assert.equal(repo.inserted[0]?.chunks.length, 2);
  assert.deepEqual(repo.inserted[0]?.chunks[0]?.embedding, [0.1, 0.2]);
  assert.deepEqual(repo.inserted[0]?.chunks[1]?.embedding, [1.1, 0.2]);
});

test('ingest: insertChunks 失敗時は文書を補償削除して元例外を再送出（孤児文書を残さない）', async () => {
  const boom = new Error('insert failed');
  repo.insertChunksError = boom;
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });

  await assert.rejects(
    () => svc.ingest('u1', { document: { collectionId: 'c1', title: 't' }, text: '# A\n本文A' }),
    (err) => err === boom, // 元例外をそのまま再送出する
  );
  // 文書は作られたが、insert 失敗で補償削除される（owner スコープ）。
  assert.equal(repo.created.length, 1);
  assert.deepEqual(repo.deleted, [{ documentId: 'doc1', ownerUserId: 'u1' }]);
  assert.equal(repo.inserted.length, 0);
});

test('ingest: 空文書はチャンク 0・embed/insert を呼ばない', async () => {
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  const result = await svc.ingest('u1', {
    document: { collectionId: 'c1', title: 't' },
    text: '   ',
  });
  assert.equal(result.chunkCount, 0);
  assert.equal(embedCalls.length, 0);
  assert.equal(repo.inserted.length, 0);
  assert.equal(repo.created.length, 1); // 文書だけは作る
});

test('retrieve: ベクトル＋全文を fetchK で引き RRF 順でチャンクを返す', async () => {
  repo.vectorHits = [
    { id: 'c1', score: 0.9 },
    { id: 'c2', score: 0.8 },
  ];
  repo.bigmHits = [
    { id: 'c2', score: 0.5 },
    { id: 'c3', score: 0.4 },
  ];
  repo.records = [
    { id: 'c1', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 1, chunkText: 'A', headerPath: null },
    { id: 'c2', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 2, chunkText: 'B', headerPath: 'H' },
    { id: 'c3', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 3, chunkText: 'C', headerPath: null },
  ];

  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  const out = await svc.retrieve('u1', 'q', 'r2');

  // c2 は両リスト寄与で最上位 → RRF 順は c2, c1, c3。
  assert.deepEqual(
    out.map((r) => r.id),
    ['c2', 'c1', 'c3'],
  );
  // 検索は本人スコープ＋設定値で呼ばれる。
  assert.deepEqual(repo.vectorArgs, [{ ownerUserId: 'u1', limit: 20, collectionIds: undefined }]);
  assert.deepEqual(repo.bigmArgs, [
    { ownerUserId: 'u1', query: 'q', limit: 20, similarityLimit: 0.2, collectionIds: undefined },
  ]);
  assert.equal(embedCalls[0]?.requestId, 'r2');
});

test('retrieve: ヒット無しは空配列（getChunks を呼ばずに返る）', async () => {
  repo.vectorHits = [];
  repo.bigmHits = [];
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  const out = await svc.retrieve('u1', 'q');
  assert.deepEqual(out, []);
});

// ── rerank 段（RAG③・over-fetch→並べ替え→topM、graceful degradation） ──

const rerankConfig: RagConfig = { ...config, rrf: { k: 60, topM: 2 }, rerank: { enabled: true, candidates: 5 } };

/** 受け取った候補 id を指定順に並べ替えて返す fake（捕捉付き）。throwError 設定時は失敗を模す。 */
function fakeRerank(opts: { order?: (ids: string[]) => string[]; throwError?: Error; calls?: RerankInput[] }): RerankClient {
  return {
    async rerank(input) {
      opts.calls?.push(input);
      if (opts.throwError) {
        throw opts.throwError;
      }
      const ids = input.candidates.map((c) => c.id);
      const ordered = opts.order ? opts.order(ids) : ids;
      return { results: ordered.map((id, i) => ({ id, score: 1 - i * 0.1 })), model: 'ruri-rerank' };
    },
  };
}

test('retrieve: rerank 有効時は候補プール(candidates)へ広げ→並べ替え→topM を返す', async () => {
  // RRF 順は c1,c2,c3,c4（vector のみ寄与）。rerank で逆順へ並べ替え → 先頭 topM(2) は c4,c3。
  repo.vectorHits = [
    { id: 'c1', score: 0.9 },
    { id: 'c2', score: 0.8 },
    { id: 'c3', score: 0.7 },
    { id: 'c4', score: 0.6 },
  ];
  repo.bigmHits = [];
  repo.records = [
    { id: 'c1', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 1, chunkText: 'A', headerPath: null },
    { id: 'c2', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 2, chunkText: 'B', headerPath: null },
    { id: 'c3', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 3, chunkText: 'C', headerPath: null },
    { id: 'c4', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 4, chunkText: 'D', headerPath: null },
  ];
  const calls: RerankInput[] = [];
  const rerank = fakeRerank({ order: (ids) => [...ids].reverse(), calls });

  const svc = new RagService({ embedding: fakeEmbedding, repo, config: rerankConfig, rerank });
  const out = await svc.retrieve('u1', 'q', 'r3');

  assert.deepEqual(out.map((r) => r.id), ['c4', 'c3']);
  // over-fetch：各ソースは候補プール(5)件まで広げて引かれる（fetchK=max(20,5)=20→既定20、candidates<fetchK のため 20）。
  assert.deepEqual(repo.vectorArgs, [{ ownerUserId: 'u1', limit: 20, collectionIds: undefined }]);
  // rerank には RRF 順の全候補（chunkText 付き）が渡る。
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.candidates.map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(calls[0]?.candidates.map((c) => c.text), ['A', 'B', 'C', 'D']);
  assert.equal(calls[0]?.requestId, 'r3');
});

test('retrieve: rerank 失敗時は RRF 順 topM にフォールバック（graceful degradation）', async () => {
  repo.vectorHits = [
    { id: 'c1', score: 0.9 },
    { id: 'c2', score: 0.8 },
    { id: 'c3', score: 0.7 },
  ];
  repo.bigmHits = [];
  repo.records = [
    { id: 'c1', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 1, chunkText: 'A', headerPath: null },
    { id: 'c2', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 2, chunkText: 'B', headerPath: null },
    { id: 'c3', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 3, chunkText: 'C', headerPath: null },
  ];
  const rerank = fakeRerank({ throwError: new Error('rerank down') });

  const svc = new RagService({ embedding: fakeEmbedding, repo, config: rerankConfig, rerank });
  const out = await svc.retrieve('u1', 'q');

  // 失敗しても落ちず、RRF 順 topM(2) を返す。
  assert.deepEqual(out.map((r) => r.id), ['c1', 'c2']);
});

test('retrieve: rerank 未注入/enabled=false は RRF 順（後方互換・rerank を呼ばない）', async () => {
  repo.vectorHits = [
    { id: 'c1', score: 0.9 },
    { id: 'c2', score: 0.8 },
  ];
  repo.bigmHits = [];
  repo.records = [
    { id: 'c1', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 1, chunkText: 'A', headerPath: null },
    { id: 'c2', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 2, chunkText: 'B', headerPath: null },
  ];
  const calls: RerankInput[] = [];
  const rerank = fakeRerank({ order: (ids) => [...ids].reverse(), calls });

  // rerank 注入済みだが config.rerank.enabled=false（既定 config）→ rerank は呼ばれず RRF 順。
  const svc = new RagService({ embedding: fakeEmbedding, repo, config, rerank });
  const out = await svc.retrieve('u1', 'q');

  assert.deepEqual(out.map((r) => r.id), ['c1', 'c2']);
  assert.equal(calls.length, 0);
});

// ── 上限・ナレッジ集の絞り込み・スコア ──────────────────────────

test('ingest: チャンク数の上限を超えたら文書を作らずに投げる', async () => {
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  await assert.rejects(
    () =>
      svc.ingest('u1', {
        document: { collectionId: 'c1', title: 't' },
        text: '# A\nあ\n# B\nい\n# C\nう',
        maxChunks: 2,
      }),
    (err) => err instanceof ChunkLimitExceededError && err.chunkCount === 3 && err.maxChunks === 2,
  );
  // 断ったときは文書もチャンクも作らない（embed も呼ばない＝無駄に待たせない）。
  assert.equal(repo.created.length, 0);
  assert.equal(repo.inserted.length, 0);
  assert.equal(embedCalls.length, 0);
});

test('ingest: 上限ちょうどなら通る（境界で断らない）', async () => {
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  const result = await svc.ingest('u1', {
    document: { collectionId: 'c1', title: 't' },
    text: '# A\nあ\n# B\nい',
    maxChunks: 2,
  });
  assert.equal(result.chunkCount, 2);
});

test('ingest: 切り方の設定と埋め込みモデルをチャンクに残す', async () => {
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  await svc.ingest('u1', { document: { collectionId: 'c1', title: 't' }, text: '# A\n本文A' });
  assert.deepEqual(repo.inserted[0]?.provenance?.chunkerConfig, config.chunk);
  assert.equal(repo.inserted[0]?.provenance?.embeddingModel, 'ruri');
});

test('search: ナレッジ集の絞り込みを両方の検索へ渡す', async () => {
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  await svc.search('u1', 'q', { collectionIds: ['col1', 'col2'] });
  assert.deepEqual(repo.vectorArgs[0]?.collectionIds, ['col1', 'col2']);
  assert.deepEqual(repo.bigmArgs[0]?.collectionIds, ['col1', 'col2']);
});

test('search: topK は RAG_TOP_M を上書きする', async () => {
  repo.vectorHits = [
    { id: 'c1', score: 0.9 },
    { id: 'c2', score: 0.8 },
    { id: 'c3', score: 0.7 },
  ];
  repo.records = [
    { id: 'c1', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 1, chunkText: 'A', headerPath: null },
    { id: 'c2', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 2, chunkText: 'B', headerPath: null },
    { id: 'c3', documentId: 'd', documentTitle: 'T', collectionId: 'c-col', chunkIndex: 3, chunkText: 'C', headerPath: null },
  ];
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  const results = await svc.search('u1', 'q', { topK: 2 });
  assert.equal(results.length, 2);
  // RRF の融合スコアが降順で付く。
  assert.ok((results[0]?.score ?? 0) >= (results[1]?.score ?? 0));
  assert.equal(results[0]?.rerankScore, undefined);
});

test('search: 0 件は空の配列（文章で「該当なし」を返さない）', async () => {
  const svc = new RagService({ embedding: fakeEmbedding, repo, config });
  assert.deepEqual(await svc.search('u1', 'q'), []);
});

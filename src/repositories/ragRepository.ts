import { randomUUID } from 'node:crypto';
import { getPrisma } from '../lib/db.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/**
 * RAG 格納・検索の DB アクセス層。
 *
 * 元文書（rag_source_documents）・ナレッジ集（rag_collections）・通常列の読み書きは Prisma Client。
 * チャンクの embedding（pgvector vector(768)）は Prisma 未対応型のため、挿入（insertChunks）とベクトル/全文検索
 * （vectorSearch / bigmSearch）は raw SQL で行う。検索は owner_user_id でスコープし本人文書に限定する。
 * pg_bigm の `=%` は GUC pg_bigm.similarity_limit を見るため、SET LOCAL を同一トランザクションで設定する。
 */

/** 既定のナレッジ集の名前（画面が無かった時期に API だけで入った文書の置き場。migration と同じ名前）。 */
export const DEFAULT_COLLECTION_NAME = '未分類';

/** 同じ利用者が同じ名前のナレッジ集を作ろうとしたとき（一意制約違反）。route 層が 409 に変える。 */
export class CollectionNameConflictError extends Error {
  constructor(name: string) {
    super(`collection name already exists: ${name}`);
    this.name = 'CollectionNameConflictError';
  }
}

/** ナレッジ集 1 件（画面の一覧に出す形）。 */
export interface CollectionRecord {
  id: string;
  name: string;
  description: string | null;
  mcpEnabled: boolean;
  documentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 元文書の作成入力（3 層のメタを同時に書く）。原本が無い経路では bronze 側を省く。 */
export interface DocumentInsert {
  ownerUserId: string;
  collectionId: string;
  title: string;
  bronzeKey?: string;
  sha256?: string;
  mime?: string;
  originalFilename?: string;
  byteSize?: number;
  silverText?: string;
  extractor?: string;
  extractorVersion?: string;
  charCount?: number;
  /** ready＝チャンクまで作れた／failed＝本文を取り出せなかった。 */
  status?: string;
  error?: string;
}

/** 元文書 1 件（画面の一覧に出す形）。 */
export interface DocumentSummary {
  id: string;
  collectionId: string;
  title: string;
  mime: string | null;
  originalFilename: string | null;
  byteSize: number | null;
  charCount: number | null;
  chunkCount: number;
  extractor: string | null;
  extractorVersion: string | null;
  status: string;
  error: string | null;
  /** 原本を持つか（持たない文書は作り直せない＝画面がその旨を出す）。 */
  hasBronze: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 削除で要る最小の情報（原本のキーを知るため）。 */
export interface DocumentOwnership {
  id: string;
  collectionId: string;
  bronzeKey: string | null;
}

/** チャンク挿入入力（embedding は EmbeddingClient が返した 768 次元）。 */
export interface ChunkInsert {
  index: number;
  text: string;
  headerPath?: string;
  embedding: number[];
}

/** チャンクを作ったときの処理の記録（抽出テキストから作り直すときの手掛かり）。 */
export interface ChunkProvenance {
  /** 切り方の設定（そのまま JSON で残す）。 */
  chunkerConfig?: unknown;
  /** 埋め込みモデルの ID。 */
  embeddingModel?: string;
}

/** 検索ヒット（順位付け用。score はソース内ソートに使い、融合は RRF が順位で行う）。 */
export interface SearchHit {
  id: string;
  score: number;
}

/** 取得済みチャンク（回答生成の context・参照表示に使う）。 */
export interface ChunkRecord {
  id: string;
  documentId: string;
  documentTitle: string;
  collectionId: string;
  chunkIndex: number;
  chunkText: string;
  headerPath: string | null;
}

/** RagService が依存する契約（unit テストは fake を注入する）。 */
export interface RagRepositoryLike {
  createDocument(input: DocumentInsert): Promise<string>;
  insertChunks(
    documentId: string,
    ownerUserId: string,
    chunks: ChunkInsert[],
    provenance?: ChunkProvenance,
  ): Promise<void>;
  deleteDocument(documentId: string, ownerUserId: string): Promise<void>;
  vectorSearch(
    ownerUserId: string,
    queryEmbedding: number[],
    limit: number,
    collectionIds?: string[],
  ): Promise<SearchHit[]>;
  bigmSearch(
    ownerUserId: string,
    query: string,
    limit: number,
    similarityLimit: number,
    collectionIds?: string[],
  ): Promise<SearchHit[]>;
  getChunksByIds(ownerUserId: string, ids: string[]): Promise<ChunkRecord[]>;
}

/** ナレッジ集と文書の出し入れ（route 層が使う契約。unit テストは fake を注入する）。 */
export interface KnowledgeRepositoryLike {
  createDocument(input: DocumentInsert): Promise<string>;
  createCollection(input: {
    ownerUserId: string;
    name: string;
    description?: string;
  }): Promise<CollectionRecord>;
  listCollections(ownerUserId: string): Promise<CollectionRecord[]>;
  getCollection(ownerUserId: string, collectionId: string): Promise<CollectionRecord | undefined>;
  updateCollection(
    ownerUserId: string,
    collectionId: string,
    patch: { name?: string; description?: string },
  ): Promise<CollectionRecord | undefined>;
  /** ナレッジ集を消し、中にあった文書の原本のキーを返す（オブジェクトの削除は呼び出し側）。 */
  deleteCollection(ownerUserId: string, collectionId: string): Promise<string[] | undefined>;
  /** 既定のナレッジ集（無ければ作る）。互換のために残した投入の経路が使う。 */
  ensureDefaultCollection(ownerUserId: string): Promise<string>;
  listDocuments(ownerUserId: string, collectionId: string): Promise<DocumentSummary[]>;
  getDocument(ownerUserId: string, documentId: string): Promise<DocumentOwnership | undefined>;
  /** この原本のキーを使っている文書が既にあるか（同じ原本の二重取り込みを断るため）。 */
  isBronzeKeyUsed(ownerUserId: string, bronzeKey: string): Promise<boolean>;
  /** 文書を消す（チャンクも FK onDelete:Cascade で消える）。原本の削除は呼び出し側。 */
  deleteDocument(documentId: string, ownerUserId: string): Promise<void>;
  /** 所有者のナレッジ集のうち、与えた id のうち実在するものを返す（突合して 404 を出すため）。 */
  filterOwnedCollectionIds(ownerUserId: string, collectionIds: string[]): Promise<string[]>;
}

/** number[] を pgvector のテキストリテラル `[1,2,3]` に整形する（::vector でキャスト）。 */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

/** Prisma の一意制約違反（P2002）か。 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

export class RagRepository implements RagRepositoryLike, KnowledgeRepositoryLike {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  // ── ナレッジ集 ──────────────────────────────────────────

  async createCollection(input: {
    ownerUserId: string;
    name: string;
    description?: string;
  }): Promise<CollectionRecord> {
    try {
      const row = await this.prisma.ragCollection.create({
        data: {
          id: randomUUID(),
          ownerUserId: input.ownerUserId,
          name: input.name,
          description: input.description ?? null,
        },
      });
      return toCollectionRecord(row, 0);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new CollectionNameConflictError(input.name);
      }
      throw err;
    }
  }

  async listCollections(ownerUserId: string): Promise<CollectionRecord[]> {
    const rows = await this.prisma.ragCollection.findMany({
      where: { ownerUserId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { documents: true } } },
    });
    return rows.map((r) => toCollectionRecord(r, r._count.documents));
  }

  async getCollection(
    ownerUserId: string,
    collectionId: string,
  ): Promise<CollectionRecord | undefined> {
    const row = await this.prisma.ragCollection.findFirst({
      where: { id: collectionId, ownerUserId },
      include: { _count: { select: { documents: true } } },
    });
    return row ? toCollectionRecord(row, row._count.documents) : undefined;
  }

  /** 名前・説明を書き替える。不在・他者のものは undefined（route 層が 404 に変える）。 */
  async updateCollection(
    ownerUserId: string,
    collectionId: string,
    patch: { name?: string; description?: string },
  ): Promise<CollectionRecord | undefined> {
    // updateMany（where に owner を含められる）で他者の行に触れないようにしてから読み直す。
    try {
      const result = await this.prisma.ragCollection.updateMany({
        where: { id: collectionId, ownerUserId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
        },
      });
      if (result.count === 0) {
        return undefined;
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new CollectionNameConflictError(patch.name ?? '');
      }
      throw err;
    }
    return this.getCollection(ownerUserId, collectionId);
  }

  /**
   * ナレッジ集を消す（中の文書とチャンクは FK onDelete:Cascade で同時に消える）。
   * 返すのは中にあった文書の原本のキー（オブジェクトの削除は呼び出し側が行う）。
   * 不在・他者のものは undefined。
   */
  async deleteCollection(ownerUserId: string, collectionId: string): Promise<string[] | undefined> {
    const collection = await this.prisma.ragCollection.findFirst({
      where: { id: collectionId, ownerUserId },
      select: { id: true, documents: { select: { bronzeKey: true } } },
    });
    if (!collection) {
      return undefined;
    }
    const bronzeKeys = collection.documents
      .map((d) => d.bronzeKey)
      .filter((k): k is string => k !== null && k !== '');
    await this.prisma.ragCollection.deleteMany({ where: { id: collectionId, ownerUserId } });
    return bronzeKeys;
  }

  /**
   * 既定のナレッジ集の id を返す（無ければ作る）。互換のために残した `POST /rag/documents` が使う。
   * 同時に 2 本走って一意制約に当たったときは、作られた側を読み直す。
   */
  async ensureDefaultCollection(ownerUserId: string): Promise<string> {
    const existing = await this.prisma.ragCollection.findFirst({
      where: { ownerUserId, name: DEFAULT_COLLECTION_NAME },
      select: { id: true },
    });
    if (existing) {
      return existing.id;
    }
    try {
      const created = await this.prisma.ragCollection.create({
        data: { id: randomUUID(), ownerUserId, name: DEFAULT_COLLECTION_NAME },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const raced = await this.prisma.ragCollection.findFirst({
        where: { ownerUserId, name: DEFAULT_COLLECTION_NAME },
        select: { id: true },
      });
      if (!raced) {
        throw err;
      }
      return raced.id;
    }
  }

  async filterOwnedCollectionIds(ownerUserId: string, collectionIds: string[]): Promise<string[]> {
    if (collectionIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.ragCollection.findMany({
      where: { ownerUserId, id: { in: collectionIds } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ── 元文書 ──────────────────────────────────────────────

  /** 元文書を作成し id（生 UUID）を返す。 */
  async createDocument(input: DocumentInsert): Promise<string> {
    const id = randomUUID();
    await this.prisma.sourceDocument.create({
      data: {
        id,
        ownerUserId: input.ownerUserId,
        collectionId: input.collectionId,
        title: input.title,
        bronzeKey: input.bronzeKey ?? null,
        sha256: input.sha256 ?? null,
        mime: input.mime ?? null,
        originalFilename: input.originalFilename ?? null,
        byteSize: input.byteSize ?? null,
        silverText: input.silverText ?? null,
        extractor: input.extractor ?? null,
        extractorVersion: input.extractorVersion ?? null,
        charCount: input.charCount ?? null,
        status: input.status ?? 'ready',
        error: input.error ?? null,
      },
    });
    return id;
  }

  async listDocuments(ownerUserId: string, collectionId: string): Promise<DocumentSummary[]> {
    const rows = await this.prisma.sourceDocument.findMany({
      where: { ownerUserId, collectionId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { chunks: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      collectionId: r.collectionId,
      title: r.title,
      mime: r.mime,
      originalFilename: r.originalFilename,
      byteSize: r.byteSize,
      charCount: r.charCount,
      chunkCount: r._count.chunks,
      extractor: r.extractor,
      extractorVersion: r.extractorVersion,
      status: r.status,
      error: r.error,
      hasBronze: r.bronzeKey !== null && r.bronzeKey !== '',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** 文書の所有を確かめる（不在・他者のものは undefined）。原本のキーも返す。 */
  async getDocument(ownerUserId: string, documentId: string): Promise<DocumentOwnership | undefined> {
    const row = await this.prisma.sourceDocument.findFirst({
      where: { id: documentId, ownerUserId },
      select: { id: true, collectionId: true, bronzeKey: true },
    });
    return row ?? undefined;
  }

  /**
   * この原本のキーを使っている文書が既にあるか。
   *
   * 同じキーで 2 回取り込ませると、2 件目が上限で断られたときに**1 件目が使っている原本を消してしまう**
   * （断ったときは原本も消す規則のため）。入口で断って、その経路を閉じる。
   */
  async isBronzeKeyUsed(ownerUserId: string, bronzeKey: string): Promise<boolean> {
    const found = await this.prisma.sourceDocument.findFirst({
      where: { ownerUserId, bronzeKey },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * 文書を削除する（チャンクは FK onDelete:Cascade で同時削除）。ingest の insertChunks 失敗補償用。
   * 既に不在でもエラーにしない（補償は best-effort）。owner_user_id スコープで他者文書に触れない。
   */
  async deleteDocument(documentId: string, ownerUserId: string): Promise<void> {
    await this.prisma.sourceDocument.deleteMany({ where: { id: documentId, ownerUserId } });
  }

  // ── チャンク ────────────────────────────────────────────

  /** チャンク群を 1 文（複数行 VALUES）で挿入する。embedding は ::vector へキャスト。 */
  async insertChunks(
    documentId: string,
    ownerUserId: string,
    chunks: ChunkInsert[],
    provenance?: ChunkProvenance,
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    // 切り方の設定と埋め込みモデルは文書内で共通（チャンクごとに同じ値を書く＝行だけ見て作り直せる）。
    const chunkerConfig =
      provenance?.chunkerConfig === undefined ? null : JSON.stringify(provenance.chunkerConfig);
    const embeddingModel = provenance?.embeddingModel ?? null;
    const rows = chunks.map(
      (c) =>
        Prisma.sql`(${randomUUID()}, ${documentId}, ${ownerUserId}, ${c.index}, ${c.text}, ${
          c.headerPath ?? null
        }, ${toVectorLiteral(c.embedding)}::vector, ${chunkerConfig}::jsonb, ${embeddingModel})`,
    );
    await this.prisma.$executeRaw`
      INSERT INTO "rag_chunks" ("id", "document_id", "owner_user_id", "chunk_index", "chunk_text", "header_path", "embedding", "chunker_config", "embedding_model")
      VALUES ${Prisma.join(rows)}
    `;
  }

  /**
   * ベクトル検索（cosine 距離 <=>）。本人文書スコープ・距離昇順 top-limit。score は cosine 類似度（1-距離）。
   *
   * ナレッジ集を絞るときは元文書と結合して `collection_id` で弾く。絞り込みは HNSW の走査の後に効くため、
   * 絞り込みが強いと limit 件に届かないことがある（pgvector の既知の性質）。個人のナレッジ集の規模では
   * 実害が出ない見込みだが、大きくなったら絞り込み後の件数を見て取得数を増やす必要がある。
   */
  async vectorSearch(
    ownerUserId: string,
    queryEmbedding: number[],
    limit: number,
    collectionIds?: string[],
  ): Promise<SearchHit[]> {
    const vec = toVectorLiteral(queryEmbedding);
    if (!collectionIds || collectionIds.length === 0) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
        SELECT "id", 1 - ("embedding" <=> ${vec}::vector) AS score
        FROM "rag_chunks"
        WHERE "owner_user_id" = ${ownerUserId} AND "embedding" IS NOT NULL
        ORDER BY "embedding" <=> ${vec}::vector
        LIMIT ${limit}
      `;
      return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
    }
    const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
      SELECT ch."id", 1 - (ch."embedding" <=> ${vec}::vector) AS score
      FROM "rag_chunks" ch
      JOIN "rag_source_documents" d ON d."id" = ch."document_id"
      WHERE ch."owner_user_id" = ${ownerUserId} AND ch."embedding" IS NOT NULL
        AND d."collection_id" IN (${Prisma.join(collectionIds)})
      ORDER BY ch."embedding" <=> ${vec}::vector
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
  }

  /**
   * 全文検索（pg_bigm 2-gram）。`=%` は GUC pg_bigm.similarity_limit を見るため SET LOCAL を同一 tx で設定。
   * クエリが空なら何も返さない（bigram が作れないため）。
   */
  async bigmSearch(
    ownerUserId: string,
    query: string,
    limit: number,
    similarityLimit: number,
    collectionIds?: string[],
  ): Promise<SearchHit[]> {
    if (query.trim().length === 0) {
      return [];
    }
    // similarityLimit は config 由来の数値（ユーザ入力でない）。Number 強制で安全に SET LOCAL する。
    const setLimit = `SET LOCAL pg_bigm.similarity_limit = ${Number(similarityLimit)}`;
    const search =
      !collectionIds || collectionIds.length === 0
        ? this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
            SELECT "id", bigm_similarity("chunk_text", ${query}) AS score
            FROM "rag_chunks"
            WHERE "owner_user_id" = ${ownerUserId} AND "chunk_text" =% ${query}
            ORDER BY score DESC
            LIMIT ${limit}
          `
        : this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
            SELECT ch."id", bigm_similarity(ch."chunk_text", ${query}) AS score
            FROM "rag_chunks" ch
            JOIN "rag_source_documents" d ON d."id" = ch."document_id"
            WHERE ch."owner_user_id" = ${ownerUserId} AND ch."chunk_text" =% ${query}
              AND d."collection_id" IN (${Prisma.join(collectionIds)})
            ORDER BY score DESC
            LIMIT ${limit}
          `;
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRawUnsafe(setLimit),
      search,
    ]);
    return (rows as Array<{ id: string; score: number }>).map((r) => ({
      id: r.id,
      score: Number(r.score),
    }));
  }

  /** id 群でチャンクを取得（元文書タイトル同梱）。RRF の順位を保つよう呼び出し側で並べ替える。 */
  async getChunksByIds(ownerUserId: string, ids: string[]): Promise<ChunkRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.ragChunk.findMany({
      where: { id: { in: ids }, ownerUserId },
      select: {
        id: true,
        documentId: true,
        chunkIndex: true,
        chunkText: true,
        headerPath: true,
        document: { select: { title: true, collectionId: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      documentTitle: r.document.title,
      collectionId: r.document.collectionId,
      chunkIndex: r.chunkIndex,
      chunkText: r.chunkText,
      headerPath: r.headerPath,
    }));
  }
}

function toCollectionRecord(
  row: {
    id: string;
    name: string;
    description: string | null;
    mcpEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  documentCount: number,
): CollectionRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mcpEnabled: row.mcpEnabled,
    documentCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../lib/db.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/**
 * RAG 格納・検索の DB アクセス層。
 *
 * 元文書（rag_source_documents）と通常列の読み書きは Prisma Client。チャンクの embedding（pgvector
 * vector(768)）は Prisma 未対応型のため、挿入（insertChunks）とベクトル/全文検索（vectorSearch /
 * bigmSearch）は raw SQL で行う。検索は owner_user_id でスコープし本人文書に限定する。
 * pg_bigm の `=%` は GUC pg_bigm.similarity_limit を見るため、SET LOCAL を同一トランザクションで設定する。
 */

/** チャンク挿入入力（embedding は EmbeddingClient が返した 768 次元）。 */
export interface ChunkInsert {
  index: number;
  text: string;
  headerPath?: string;
  embedding: number[];
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
  chunkText: string;
  headerPath: string | null;
}

/** RagService が依存する契約（unit テストは fake を注入する）。 */
export interface RagRepositoryLike {
  createDocument(input: { ownerUserId: string; title: string }): Promise<string>;
  insertChunks(documentId: string, ownerUserId: string, chunks: ChunkInsert[]): Promise<void>;
  deleteDocument(documentId: string, ownerUserId: string): Promise<void>;
  vectorSearch(ownerUserId: string, queryEmbedding: number[], limit: number): Promise<SearchHit[]>;
  bigmSearch(
    ownerUserId: string,
    query: string,
    limit: number,
    similarityLimit: number,
  ): Promise<SearchHit[]>;
  getChunksByIds(ownerUserId: string, ids: string[]): Promise<ChunkRecord[]>;
}

/** number[] を pgvector のテキストリテラル `[1,2,3]` に整形する（::vector でキャスト）。 */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

export class RagRepository implements RagRepositoryLike {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  /** 元文書を作成し id（生 UUID）を返す。 */
  async createDocument(input: { ownerUserId: string; title: string }): Promise<string> {
    const id = randomUUID();
    await this.prisma.sourceDocument.create({
      data: { id, ownerUserId: input.ownerUserId, title: input.title },
    });
    return id;
  }

  /**
   * 文書を削除する（チャンクは FK onDelete:Cascade で同時削除）。ingest の insertChunks 失敗補償用。
   * 既に不在でもエラーにしない（補償は best-effort）。owner_user_id スコープで他者文書に触れない。
   */
  async deleteDocument(documentId: string, ownerUserId: string): Promise<void> {
    await this.prisma.sourceDocument.deleteMany({ where: { id: documentId, ownerUserId } });
  }

  /** チャンク群を 1 文（複数行 VALUES）で挿入する。embedding は ::vector へキャスト。 */
  async insertChunks(documentId: string, ownerUserId: string, chunks: ChunkInsert[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const rows = chunks.map(
      (c) =>
        Prisma.sql`(${randomUUID()}, ${documentId}, ${ownerUserId}, ${c.index}, ${c.text}, ${
          c.headerPath ?? null
        }, ${toVectorLiteral(c.embedding)}::vector)`,
    );
    await this.prisma.$executeRaw`
      INSERT INTO "rag_chunks" ("id", "document_id", "owner_user_id", "chunk_index", "chunk_text", "header_path", "embedding")
      VALUES ${Prisma.join(rows)}
    `;
  }

  /** ベクトル検索（cosine 距離 <=>）。本人文書スコープ・距離昇順 top-limit。score は cosine 類似度（1-距離）。 */
  async vectorSearch(ownerUserId: string, queryEmbedding: number[], limit: number): Promise<SearchHit[]> {
    const vec = toVectorLiteral(queryEmbedding);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
      SELECT "id", 1 - ("embedding" <=> ${vec}::vector) AS score
      FROM "rag_chunks"
      WHERE "owner_user_id" = ${ownerUserId} AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${vec}::vector
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
  ): Promise<SearchHit[]> {
    if (query.trim().length === 0) {
      return [];
    }
    // similarityLimit は config 由来の数値（ユーザ入力でない）。Number 強制で安全に SET LOCAL する。
    const setLimit = `SET LOCAL pg_bigm.similarity_limit = ${Number(similarityLimit)}`;
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRawUnsafe(setLimit),
      this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
        SELECT "id", bigm_similarity("chunk_text", ${query}) AS score
        FROM "rag_chunks"
        WHERE "owner_user_id" = ${ownerUserId} AND "chunk_text" =% ${query}
        ORDER BY score DESC
        LIMIT ${limit}
      `,
    ]);
    return (rows as Array<{ id: string; score: number }>).map((r) => ({ id: r.id, score: Number(r.score) }));
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
        chunkText: true,
        headerPath: true,
        document: { select: { title: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      documentTitle: r.document.title,
      chunkText: r.chunkText,
      headerPath: r.headerPath,
    }));
  }
}

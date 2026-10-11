import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest, notFound } from '../../lib/http/errors.js';
import { parseBody, requirePathParam } from '../../lib/http/validation.js';
import { extractKnowledgeText } from '../../lib/knowledge/extract.js';
import {
  filenameOfKey,
  isSafeOwnedKey,
  knowledgeObjectKey,
} from '../../lib/knowledge/objectKey.js';
import { ChunkLimitExceededError } from '../../lib/rag/ragService.js';
import { currentRequestId, getRequestLogger } from '../../middleware/requestContext.js';
import type { DocumentSummary } from '../../repositories/ragRepository.js';
import { deleteBronzeObjects } from './collections.js';
import { requireKnowledgeBucket, requireOwnedCollection } from './collectionAccess.js';
import type { RagDeps } from './deps.js';
import { knowledgeIngestSchema } from './schemas.js';

/**
 * ナレッジ集の文書の投入・一覧・削除（-onpre 新規）。
 *
 * 投入は同期。原本（Bronze）を読む → 形式を判定して本文を取り出す（Silver）→ チャンクに切って埋め込む（Gold）
 * までを 1 回のリクエストで行う。上限（`KNOWLEDGE_*`）を超えたら**切り詰めずに断り、文書を作らず原本も消す**。
 * 読める形式なのに文字が取れなかったときだけ `status="failed"` の文書を作り、原本は残す（抽出器を
 * 良くしたときに作り直せるようにするため）。
 */

/** 貼り付けたテキストを原本として置くときのファイル名。 */
const PASTED_TEXT_EXTENSION = '.txt';

/** 投入 1 件分の実測（ログに出す項目）。 */
export interface IngestMeasurement {
  documentId: string;
  /** 中身を見て決めた形式。 */
  mime: string;
  charCount: number;
  chunkCount: number;
  /** 本文の取り出しに掛かった時間（ms）。 */
  extractMs: number;
  /** 埋め込みに掛かった時間（ms）。本文が取れなかったときは 0。 */
  embedMs: number;
}

/**
 * 投入 1 件分の実測を 1 行にまとめる。
 *
 * **本文・原本のキー・元のファイル名は載せない**（ログは中身を持たない）。文書の id と形式だけで、
 * どの文書の実測かは一覧と突き合わせれば分かる。統合確認ではこの行を拾って、形式ごとの
 * 文字数・チャンク数・時間を読む。
 */
export function ingestMeasurement(m: IngestMeasurement): IngestMeasurement {
  return {
    documentId: m.documentId,
    mime: m.mime,
    charCount: m.charCount,
    chunkCount: m.chunkCount,
    extractMs: m.extractMs,
    embedMs: m.embedMs,
  };
}

function toBody(d: DocumentSummary) {
  return {
    documentId: d.id,
    collectionId: d.collectionId,
    title: d.title,
    mime: d.mime,
    originalFilename: d.originalFilename,
    byteSize: d.byteSize,
    charCount: d.charCount,
    chunkCount: d.chunkCount,
    extractor: d.extractor,
    extractorVersion: d.extractorVersion,
    status: d.status,
    error: d.error,
    hasBronze: d.hasBronze,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function createListKnowledgeDocumentsHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const collection = await requireOwnedCollection(deps, req, auth.userId);
    const documents = await deps.knowledge.listDocuments(auth.userId, collection.id);
    return { status: 200, body: { documents: documents.map(toBody) } };
  });
}

/**
 * 文書の投入（POST /rag/collections/:collectionId/documents）。
 * `{bronzeKey, title?}`＝署名付き URL で上げた原本を読む／`{title, text}`＝貼り付けたテキストを原本として置く。
 */
export function createIngestKnowledgeDocumentHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const collection = await requireOwnedCollection(deps, req, auth.userId);
    const bucket = requireKnowledgeBucket(deps);
    const body = parseBody(knowledgeIngestSchema, req.body);
    const requestId = currentRequestId();
    const log = getRequestLogger().child({ component: 'api.rag.knowledge' });

    // 原本（Bronze）を用意する。上げたファイルは読み、貼り付けたテキストは原本として置いてから同じ経路に乗せる。
    let bronzeKey: string;
    let bytes: Uint8Array;
    if (body.bronzeKey !== undefined) {
      if (!isSafeOwnedKey(body.bronzeKey, auth.userId)) {
        // 他人のキー・形の違うキーは「無い」として扱う（在ることを漏らさない）。
        throw notFound('アップロードしたファイルが見つかりません。');
      }
      bronzeKey = body.bronzeKey;
      // 同じ原本を 2 回取り込ませない。2 件目が上限で断られると、断る規則に従って原本を消すため、
      // 1 件目が「原本はあるのに実体が無い」状態になる。
      if (await deps.knowledge.isBronzeKeyUsed(auth.userId, bronzeKey)) {
        throw badRequest('このファイルはすでに取り込まれています。');
      }
      try {
        bytes = await deps.storage.getObject(bucket, bronzeKey);
      } catch (err) {
        log.warn(
          {
            event: 'bronze_read_failed',
            error: { message: err instanceof Error ? err.message : String(err) },
          },
          'failed to read the uploaded original',
        );
        throw notFound('アップロードしたファイルが見つかりません。もう一度上げ直してください。');
      }
    } else {
      const text = body.text as string;
      bytes = new Uint8Array(Buffer.from(text, 'utf8'));
      if (bytes.byteLength > deps.limits.maxBytes) {
        throw badRequest(`本文が大きすぎます（上限 ${deps.limits.maxBytes} バイト）。`);
      }
      bronzeKey = knowledgeObjectKey(
        auth.userId,
        `${body.title as string}${PASTED_TEXT_EXTENSION}`,
        `pasted${PASTED_TEXT_EXTENSION}`,
      );
      await deps.storage.putObject(bucket, bronzeKey, bytes, 'text/plain; charset=utf-8');
    }

    const originalFilename = filenameOfKey(bronzeKey);
    const title = body.title ?? originalFilename;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // **抽出の前に測る。** pdfjs は渡したバイト列の持ち主になり、読み終えると byteLength が 0 になる
    // （抽出の後に数えると PDF だけ 0 バイトとして記録される）。
    const byteSize = bytes.byteLength;

    // 抽出テキスト（Silver）を作る。上限を超えたら文書を作らず原本も消す。
    // 形式はファイル名の拡張子と**中身の先頭のバイト列**で決める（クライアントの名乗りは受け取らない）。
    const extractStartedAt = performance.now();
    const extracted = await extractKnowledgeText(bytes, originalFilename, '', deps.limits);
    const extractMs = Math.round(performance.now() - extractStartedAt);
    if (extracted.kind === 'rejected') {
      await deleteBronzeObjects(deps, [bronzeKey], 'ingest_rejected');
      log.info(
        { event: 'ingest_rejected', reason: extracted.reason, byteSize, extractMs },
        'ingest rejected',
      );
      throw badRequest(extracted.message);
    }

    if (extracted.kind === 'failed') {
      // 読める形式なのに文字が取れなかった。原本は残し、作り直せる余地を残す。
      const documentId = await deps.knowledge.createDocument({
        ownerUserId: auth.userId,
        collectionId: collection.id,
        title,
        bronzeKey,
        sha256,
        mime: extracted.mime,
        originalFilename,
        byteSize,
        extractor: extracted.extractor,
        extractorVersion: extracted.extractorVersion,
        status: 'failed',
        error: extracted.message,
      });
      log.info(
        {
          event: 'ingest_failed',
          ...ingestMeasurement({
            documentId,
            mime: extracted.mime,
            charCount: 0,
            chunkCount: 0,
            extractMs,
            embedMs: 0,
          }),
        },
        'ingest failed to extract text',
      );
      return {
        status: 200,
        body: {
          documentId,
          collectionId: collection.id,
          title,
          status: 'failed',
          charCount: 0,
          chunkCount: 0,
          error: extracted.message,
        },
      };
    }

    // チャンクと埋め込み（Gold）。チャンク数の上限を超えたら文書を作らず原本も消す。
    try {
      const result = await deps.rag.ingest(
        auth.userId,
        {
          document: {
            collectionId: collection.id,
            title,
            bronzeKey,
            sha256,
            mime: extracted.mime,
            originalFilename,
            byteSize,
            silverText: extracted.text,
            extractor: extracted.extractor,
            extractorVersion: extracted.extractorVersion,
            charCount: extracted.charCount,
            status: 'ready',
          },
          text: extracted.text,
          maxChunks: deps.limits.maxChunks,
        },
        requestId,
      );
      log.info(
        {
          event: 'ingest_completed',
          ...ingestMeasurement({
            documentId: result.documentId,
            mime: extracted.mime,
            charCount: extracted.charCount,
            chunkCount: result.chunkCount,
            extractMs,
            embedMs: result.embedMs,
          }),
        },
        'ingest completed',
      );
      return {
        status: 201,
        body: {
          documentId: result.documentId,
          collectionId: collection.id,
          title,
          status: 'ready',
          mime: extracted.mime,
          originalFilename,
          byteSize,
          charCount: extracted.charCount,
          chunkCount: result.chunkCount,
          extractor: extracted.extractor,
          extractorVersion: extracted.extractorVersion,
        },
      };
    } catch (err) {
      if (err instanceof ChunkLimitExceededError) {
        await deleteBronzeObjects(deps, [bronzeKey], 'ingest_rejected');
        log.info(
          {
            event: 'ingest_rejected',
            reason: 'too_many_chunks',
            mime: extracted.mime,
            charCount: extracted.charCount,
            chunkCount: err.chunkCount,
            maxChunks: err.maxChunks,
            extractMs,
          },
          'ingest rejected',
        );
        throw badRequest(
          `文書が大きすぎます（${err.chunkCount} チャンク・上限 ${err.maxChunks} チャンク）。文書を分けて取り込んでください。`,
        );
      }
      throw err;
    }
  });
}

/**
 * 文書を 3 層とも消す（DELETE /rag/documents/:documentId）。
 * DB を先に消し、原本のオブジェクトを後から消す（失敗はログに残す）。
 */
export function createDeleteKnowledgeDocumentHandler(deps: RagDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const documentId = requirePathParam(req, 'documentId');
    const document = await deps.knowledge.getDocument(auth.userId, documentId);
    if (!document) {
      throw notFound('文書が見つかりません。');
    }
    await deps.knowledge.deleteDocument(document.id, auth.userId);
    if (document.bronzeKey) {
      await deleteBronzeObjects(deps, [document.bronzeKey], 'document_deleted');
    }
    return { status: 204 };
  });
}

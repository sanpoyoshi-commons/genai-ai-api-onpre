import { Router } from 'express';
import { createAskHandler } from './ask.js';
import {
  createCreateCollectionHandler,
  createDeleteCollectionHandler,
  createListCollectionsHandler,
  createUpdateCollectionHandler,
} from './collections.js';
import type { RagDeps } from './deps.js';
import { createIngestDocumentHandler } from './ingestDocument.js';
import {
  createDeleteKnowledgeDocumentHandler,
  createIngestKnowledgeDocumentHandler,
  createListKnowledgeDocumentsHandler,
} from './knowledgeDocuments.js';
import { createQueryHandler } from './query.js';
import { createSearchHandler } from './search.js';
import { createKnowledgeUploadUrlHandler } from './uploads.js';

/**
 * rag リソース群 Router（-onpre 新規）。/api 配下（requireAuth 内側）にマウント。
 * 本リポは一般文書 RAG を新規実装：ナレッジ集（collections）＋文書の投入・一覧・削除＋
 * 検索だけ（search）＋ retrieve-and-generate（query／ask）。
 * `POST /rag/documents` は画面が無かった時期からの経路で、互換のために残す（既定のナレッジ集へ入る）。
 */
export function createRagRouter(deps: RagDeps): Router {
  const router = Router();

  router.get('/rag/collections', createListCollectionsHandler(deps));
  router.post('/rag/collections', createCreateCollectionHandler(deps));
  router.put('/rag/collections/:collectionId', createUpdateCollectionHandler(deps));
  router.delete('/rag/collections/:collectionId', createDeleteCollectionHandler(deps));

  router.post('/rag/collections/:collectionId/uploads', createKnowledgeUploadUrlHandler(deps));
  router.get('/rag/collections/:collectionId/documents', createListKnowledgeDocumentsHandler(deps));
  router.post(
    '/rag/collections/:collectionId/documents',
    createIngestKnowledgeDocumentHandler(deps),
  );
  router.delete('/rag/documents/:documentId', createDeleteKnowledgeDocumentHandler(deps));

  router.post('/rag/search', createSearchHandler(deps));
  router.post('/rag/ask', createAskHandler(deps));
  router.post('/rag/documents', createIngestDocumentHandler(deps));
  router.post('/rag/query', createQueryHandler(deps));
  return router;
}

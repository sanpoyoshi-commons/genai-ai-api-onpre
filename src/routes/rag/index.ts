import { Router } from 'express';
import type { RagDeps } from './deps.js';
import { createIngestDocumentHandler } from './ingestDocument.js';
import { createQueryHandler } from './query.js';

/**
 * rag リソース群 Router（-onpre 新規）。/api 配下（requireAuth 内側）にマウント。
 * 本リポは一般文書 RAG を新規実装：POST /rag/documents（ingest）＋ POST /rag/query（retrieve-and-generate）。
 */
export function createRagRouter(deps: RagDeps): Router {
  const router = Router();
  router.post('/rag/documents', createIngestDocumentHandler(deps));
  router.post('/rag/query', createQueryHandler(deps));
  return router;
}

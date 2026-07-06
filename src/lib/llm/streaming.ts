import type { StreamingChunk } from '../../types/genaiWeb.js';

/**
 * ストリーミング応答の 1 行整形（上流 streamingChunk のアイデア領域、MIT）。
 *
 * 上流 predictStream は API Gateway 非経由の Lambda response streaming で、各トークンを
 * `JSON.stringify(StreamingChunk) + '\n'`（JSONL）で書き出す。本リポは Express の chunked 応答で
 * 同形を流し、フロント無改修を保つ（SSE の `data:` 枠は付けない）。
 */
export function streamingChunkLine(chunk: StreamingChunk): string {
  return `${JSON.stringify(chunk)}\n`;
}

import { Agent, setGlobalDispatcher } from 'undici';

const DEFAULT_HTTP_TIMEOUT_MS = 1_800_000; // 30 分（LLM 既定と同値）

/**
 * Node 標準 fetch(undici) の既定 headersTimeout/bodyTimeout（各 300s）を延長する。
 *
 * これをしないと、ollama が大きいプロンプト（例: ダイアグラム生成の数千トークン）を CPU で prefill する間
 * （300s 超になり得る）に応答ヘッダを返す前で undici が 300s で接続を切り、OpenAI SDK の timeout
 * （timeoutMs）や各アダプタの AbortController が効く前に "Request timed out" になる。
 *
 * per-request の dispatcher 指定は OpenAI SDK の fetch 経路を素通りしない（実測で効かず）ため、
 * プロセス全体の undici 既定 dispatcher を差し替える。各経路の AbortController / SDK timeout
 * （LLM=30分・embedding=5分・rerank=1分）が実効リミットになり、undici が早期に切らなくなる。
 * exApp は独自の per-request dispatcher を持つため本設定の影響を受けない。
 *
 * 値は LLM_DEFAULT_TIMEOUT_MS（既定 30 分）に追従する。
 */
export function configureGlobalHttpTimeouts(env: NodeJS.ProcessEnv = process.env): void {
  const raw = Number.parseInt(env.LLM_DEFAULT_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HTTP_TIMEOUT_MS;
  setGlobalDispatcher(new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }));
}

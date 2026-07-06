import { loadSandboxClientConfig, type SandboxClientConfig } from './config.js';
import { SandboxError } from './errors.js';
import type { SandboxClient, SandboxExecInput, SandboxExecResult, SandboxStatus } from './sandboxClient.js';

/**
 * NsJail サンドボックスコンテナ（別 service `sandbox`、profile sandbox）への HTTP 委譲。
 *
 * 契約：`POST {baseUrl}/eval` に { code, files[{name, content_b64}], timeout_ms, output_globs } を送り、
 * { status, exit_code, stdout, stderr, files[{name, content_b64}] } を受ける。openai SDK は使わず raw fetch ＋
 * AbortController でタイムアウトを掛ける（teiRerankAdapter と同流儀）。config/fetch は lazy・注入可（unit はモック）。
 * コード実行の失敗（status error/timeout）は正常な戻り値、サンドボックス到達失敗のみ SandboxError に正規化する。
 */

/** /eval レスポンス（サンドボックス server.py の契約）。 */
interface SandboxEvalResponse {
  status: SandboxStatus;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  files?: { name: string; content_b64: string }[];
}

export class HttpSandboxClient implements SandboxClient {
  private config?: SandboxClientConfig;

  constructor(private readonly configFactory: () => SandboxClientConfig = loadSandboxClientConfig) {}

  private get(): SandboxClientConfig {
    if (!this.config) {
      this.config = this.configFactory();
    }
    return this.config;
  }

  async execute(input: SandboxExecInput): Promise<SandboxExecResult> {
    const cfg = this.get();
    const doFetch = cfg.fetch ?? fetch;
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/eval`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: input.code,
          files: input.files.map((f) => ({ name: f.name, content_b64: f.bytes.toString('base64') })),
          timeout_ms: input.timeoutMs,
          output_globs: input.outputGlobs ?? ['*.png'],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new SandboxError('protocol', `sandbox /eval ${res.status}: ${detail}`, { requestId: input.requestId });
      }
      const data = (await res.json()) as SandboxEvalResponse;
      if (data.status !== 'ok' && data.status !== 'error' && data.status !== 'timeout') {
        throw new SandboxError('protocol', `sandbox /eval invalid status: ${String(data.status)}`, {
          requestId: input.requestId,
        });
      }
      return {
        status: data.status,
        exitCode: typeof data.exit_code === 'number' ? data.exit_code : -1,
        stdout: data.stdout ?? '',
        stderr: data.stderr ?? '',
        files: (data.files ?? []).map((f) => ({ name: f.name, bytes: Buffer.from(f.content_b64, 'base64') })),
      };
    } catch (err) {
      throw toSandboxError(err, input.requestId);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** fetch 経路の例外 → SandboxError 正規化。 */
function toSandboxError(err: unknown, requestId: string): SandboxError {
  if (err instanceof SandboxError) {
    return err;
  }
  // AbortController による HTTP タイムアウト（abort）は AbortError として届く。
  if (err instanceof Error && err.name === 'AbortError') {
    return new SandboxError('timeout', 'サンドボックスへの呼び出しがタイムアウトしました。', { cause: err, requestId });
  }
  // fetch の接続失敗は TypeError（'fetch failed' 等）として届く。
  if (err instanceof TypeError) {
    return new SandboxError('down', 'サンドボックスに接続できませんでした。', { cause: err, requestId });
  }
  return new SandboxError('protocol', err instanceof Error ? err.message : String(err), { cause: err, requestId });
}

import { Agent } from 'undici';
import type { ApiKeyStore } from '../apikey/apiKeyStore.js';
import { logger } from '../logger.js';
import type { FileStorage } from '../storage/fileStorage.js';
import type { ExAppRepository } from '../../repositories/exAppRepository.js';
import type { ExecutionContext, HistoryKey, InvokeHistoryRepository } from '../../repositories/invokeHistoryRepository.js';
import type { ExAppStatusChecker, ExAppStatusResult } from '../../workers/processExAppJob.js';
import type { ExAppExecConfig } from './config.js';
import { assertAllowedEndpoint, EndpointNotAllowedError, type EndpointPolicy } from './endpointSecurity.js';

/**
 * ExApp 外部呼び出しの本実装（worker checkStatus seam の実体）。
 *
 * worker-centric を維持する（設計方針）：invoke ルートは 202 即返し、worker が初回 POST から polling まで担う。
 * - 初回受信（履歴に statusUrl 無し）：endpoint/apiKey/inputs を引き、SSRF 検証 →`POST {inputs}` ＋
 *   ヘッダ（x-api-key／x-user-id）。202＋status_url なら statusUrl を永続化し done:false（以後 polling）。
 *   それ以外の 2xx は同期成功＝outputs/artifacts を取り出して done:true。>=400 は error。
 * - 以後の受信（statusUrl 永続化済み）：`GET status_url`（apiKey 付）→ COMPLETED/ERROR/継続を判定。
 * artifacts(base64)・閾値超 outputs は SeaweedFS（artifactsBucket）へ退避し、履歴には参照（s3://）を持たせる。
 *
 * プロトコルは AIアプリAPI仕様（仕様の単一の真実）に準拠。逐語移植せず仕様参照で再実装する。
 */

export interface ExAppInvokerDeps {
  exApps: Pick<ExAppRepository, 'findEndpoint'>;
  apiKeys: Pick<ApiKeyStore, 'getApiKey'>;
  histories: Pick<InvokeHistoryRepository, 'findExecution' | 'saveExternalState'>;
  storage: Pick<FileStorage, 'putObject'>;
  /** artifacts 退避先バケット（未設定時は退避せず参照のみ落とす）。 */
  artifactsBucket: string | undefined;
  config: ExAppExecConfig;
  /** テスト注入用（既定はグローバル fetch）。 */
  fetchFn?: typeof fetch;
}

/** 履歴へ書き戻す outputs の構造化形（artifacts 退避時）。テキストのみは string で返す。 */
interface StructuredOutputs {
  outputs: string;
  artifacts: { displayName: string; s3Url: string }[];
}

interface ParsedBody {
  json: Record<string, unknown> | null;
  text: string;
}

const log = logger.child({ component: 'api.worker.exapp.invoker' });

function errorOutputs(message: string, details?: unknown): { error: { message: string; details?: unknown } } {
  return { error: details === undefined ? { message } : { message, details } };
}

/**
 * 相対 status_url を endpoint の origin に解決する（絶対 URL はそのまま）。
 * 解決後の origin が初回 endpoint と異なる場合は fail-closed で拒否する（異オリジン誘導・
 * `//host` 等のスキーム相対による origin 乗っ取りを塞ぐ defense-in-depth）。後段の
 * assertAllowedEndpoint（private/allowlist）と二重で SSRF を防ぐ。
 */
function resolveStatusUrl(base: URL, statusUrl: string): string {
  const resolved = new URL(statusUrl, base);
  if (resolved.origin !== base.origin) {
    throw new EndpointNotAllowedError(`status_url origin mismatch: ${resolved.origin} != ${base.origin}`);
  }
  return resolved.toString();
}

/** base64 を安全に Uint8Array へ。不正は null。 */
function decodeBase64(b64: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

/** ストレージキーに使えない文字を除去する（パストラバーサル/区切り混入を防ぐ）。 */
function sanitizeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

export function createExAppInvoker(deps: ExAppInvokerDeps): ExAppStatusChecker {
  const doFetch = deps.fetchFn ?? fetch;
  const policy: EndpointPolicy = {
    allowPrivateEndpoints: deps.config.allowPrivateEndpoints,
    allowlist: deps.config.endpointAllowlist,
  };

  // Node 既定 fetch(undici) の headersTimeout/bodyTimeout（各 300s 既定）は AbortController
  // （EXAPP_HTTP_TIMEOUT_MS）より先に発火し、5 分超の長時間 ExApp（CPU 上の law-rag 等）を
  // "fetch failed" で切断する。タイムアウト制御を AbortController に一本化するため、undici の各
  // タイムアウトを httpTimeoutMs に揃えた専用 dispatcher を使う。
  const longTimeoutDispatcher = new Agent({
    headersTimeout: deps.config.httpTimeoutMs,
    bodyTimeout: deps.config.httpTimeoutMs,
  });

  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.config.httpTimeoutMs);
    try {
      // dispatcher は Node 同梱 undici-types の RequestInit には型として無いため unknown 経由で渡す
      // （ランタイムでは Node の fetch が init.dispatcher を尊重する）。
      return await doFetch(url, {
        ...init,
        signal: controller.signal,
        dispatcher: longTimeoutDispatcher,
      } as unknown as RequestInit);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBody(res: Response): Promise<ParsedBody> {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return { json: json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : null, text };
    } catch {
      // JSON 不正時は text を outputs 扱い（仕様踏襲）。
      return { json: null, text };
    }
  }

  /** outputs テキストを決定する。 */
  function pickOutputsText(parsed: ParsedBody): string {
    if (parsed.json && 'outputs' in parsed.json) {
      const o = parsed.json.outputs;
      return typeof o === 'string' ? o : JSON.stringify(o);
    }
    if (parsed.json) {
      return JSON.stringify(parsed.json);
    }
    return parsed.text;
  }

  /** COMPLETED/同期成功の body から outputs/artifacts を組み立て、退避して履歴書き戻し用の値を返す。 */
  async function buildSuccess(parsed: ParsedBody, key: HistoryKey): Promise<ExAppStatusResult> {
    const text = pickOutputsText(parsed);
    const artifacts: { displayName: string; s3Url: string }[] = [];
    const createdMs = key.createdDate.getTime();

    const rawArtifacts = parsed.json?.artifacts;
    if (Array.isArray(rawArtifacts) && deps.artifactsBucket) {
      let idx = 0;
      for (const a of rawArtifacts) {
        if (typeof a !== 'object' || a === null) continue;
        const entry = a as { contents?: unknown; display_name?: unknown };
        const displayName = typeof entry.display_name === 'string' ? entry.display_name : `artifact-${idx}`;
        const bytes = typeof entry.contents === 'string' ? decodeBase64(entry.contents) : null;
        if (!bytes) {
          idx += 1;
          continue;
        }
        const storageKey = `${key.userId}/${key.exAppId}/${createdMs}/${idx}-${sanitizeName(displayName)}`;
        await deps.storage.putObject(deps.artifactsBucket, storageKey, bytes);
        artifacts.push({ displayName, s3Url: `s3://${deps.artifactsBucket}/${storageKey}` });
        idx += 1;
      }
    } else if (Array.isArray(rawArtifacts) && rawArtifacts.length > 0) {
      log.warn({ event: 'artifacts_offload_skipped' }, 'artifacts present but ARTIFACTS_BUCKET_NAME is not configured');
    }

    // 閾値超 outputs はストレージへ退避し、参照を artifacts に積む（DB 行を小さく保つ）。
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes > deps.config.artifactThresholdBytes && deps.artifactsBucket) {
      const storageKey = `${key.userId}/${key.exAppId}/${createdMs}/outputs.txt`;
      await deps.storage.putObject(deps.artifactsBucket, storageKey, new Uint8Array(Buffer.from(text, 'utf8')), 'text/plain');
      artifacts.push({ displayName: 'outputs.txt', s3Url: `s3://${deps.artifactsBucket}/${storageKey}` });
      return { done: true, status: 'success', outputs: { outputs: '', artifacts } satisfies StructuredOutputs };
    }

    if (artifacts.length > 0) {
      return { done: true, status: 'success', outputs: { outputs: text, artifacts } satisfies StructuredOutputs };
    }
    return { done: true, status: 'success', outputs: text };
  }

  async function firstPost(
    endpoint: string,
    apiKey: string | null,
    inputs: unknown,
    userId: string,
    key: HistoryKey,
  ): Promise<ExAppStatusResult> {
    const url = assertAllowedEndpoint(endpoint, policy);
    const res = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      // 検証済み URL のみへ送る。リダイレクト追従で未検証の内部宛へ飛ぶ SSRF 抜けを塞ぐ（fail-closed）。
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'x-user-id': userId,
      },
      body: JSON.stringify({ inputs: inputs ?? {} }),
    });
    const parsed = await readBody(res);

    // 非同期：202＋status_url。statusUrl を解決・検証して永続化し、以後 polling へ。
    const statusUrl = typeof parsed.json?.status_url === 'string' ? parsed.json.status_url : null;
    if (res.status === 202 && statusUrl) {
      const resolved = resolveStatusUrl(url, statusUrl);
      assertAllowedEndpoint(resolved, policy);
      const requestId = typeof parsed.json?.request_id === 'string' ? parsed.json.request_id : null;
      await deps.histories.saveExternalState(key, resolved, requestId);
      log.info({ event: 'exapp_async_accepted', request_id: requestId }, 'exapp accepted (async polling)');
      return { done: false };
    }

    if (res.status >= 400) {
      log.warn({ event: 'exapp_sync_error', status_code: res.status }, 'exapp sync call returned error');
      return { done: true, status: 'error', outputs: errorOutputs(`external app returned ${res.status}`, parsed.json ?? parsed.text) };
    }

    // 同期成功。
    return buildSuccess(parsed, key);
  }

  async function pollStatus(statusUrl: string, apiKey: string | null, key: HistoryKey): Promise<ExAppStatusResult> {
    const url = assertAllowedEndpoint(statusUrl, policy);
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      // リダイレクト追従による SSRF 抜けを塞ぐ（fail-closed）。
      redirect: 'error',
      headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    });
    const parsed = await readBody(res);

    if (res.status >= 400) {
      log.warn({ event: 'exapp_poll_error', status_code: res.status }, 'exapp status poll returned error');
      return { done: true, status: 'error', outputs: errorOutputs(`status check returned ${res.status}`, parsed.json ?? parsed.text) };
    }

    const status = typeof parsed.json?.status === 'string' ? parsed.json.status : '';
    if (status === 'COMPLETED') {
      return buildSuccess(parsed, key);
    }
    if (status === 'ERROR') {
      return { done: true, status: 'error', outputs: errorOutputs('external app reported ERROR', parsed.json?.error) };
    }
    // PENDING / IN_PROGRESS / 未知 → 未完了（再配信）。
    return { done: false };
  }

  const checker: ExAppStatusChecker = async (message, _job) => {
    const key: HistoryKey = {
      teamId: message.teamId,
      exAppId: message.exAppId,
      userId: message.userId,
      createdDate: new Date(message.createdDate),
    };

    const ctx: ExecutionContext | null = await deps.histories.findExecution(key);
    if (!ctx) {
      // 履歴消失（TTL 等）。再試行不能のため error 完了で打ち切る。
      return { done: true, status: 'error', outputs: errorOutputs('invoke history not found') };
    }

    try {
      const apiKey = await deps.apiKeys.getApiKey(message.teamId, message.exAppId);

      if (ctx.statusUrl) {
        return await pollStatus(ctx.statusUrl, apiKey, key);
      }

      const endpoint = await deps.exApps.findEndpoint(message.teamId, message.exAppId);
      if (!endpoint) {
        return { done: true, status: 'error', outputs: errorOutputs('external app endpoint is not configured') };
      }
      return await firstPost(endpoint, apiKey, ctx.inputs, message.userId, key);
    } catch (err) {
      // SSRF 拒否は再試行しても通らないため error 完了で打ち切る。
      if (err instanceof EndpointNotAllowedError) {
        log.warn({ event: 'exapp_endpoint_blocked', reason: err.message }, 'exapp endpoint blocked by SSRF guard');
        return { done: true, status: 'error', outputs: errorOutputs(err.message) };
      }
      // 通信エラー（timeout 等）は throw して runPollExAppStatus のリトライ（backoff 再配信）に委ねる。
      throw err;
    }
  };

  return checker;
}

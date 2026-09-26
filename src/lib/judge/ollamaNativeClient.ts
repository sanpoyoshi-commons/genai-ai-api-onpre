/**
 * Ollama ネイティブ `/api/chat` への委譲（-onpre 新規）。
 *
 * 既存 LLM 経路（openai SDK・OpenAI 互換 `/v1`）は **logprobs を返さない**ため、判定だけは
 * ネイティブ API を素の fetch ＋ AbortSignal で叩く（teiRerankAdapter / HttpSandboxClient と同流儀。
 * undici の global dispatcher には触らない＝既存 30 分設定を壊さない）。
 *
 * 送信は `num_predict:1` / `temperature:0` / `think:false` / `stream:false` で、
 * **`num_ctx` は送らない**（リクエストでコンテキスト長を変えるとモデルの読み直しが起き得るため）。
 * 読むのは 1 トークン目の `top_logprobs` だけ。`keep_alive` も送らない（Ollama 既定の 5 分に従う）。
 *
 * 時間制御は 3 層（本家 SDK の方針に倣う）：
 *  1. 1 回の上流呼び出し（fetch 1 回）＝`attemptTimeoutMs`（既定 300 秒）
 *  2. リクエスト全体（全問・リトライ込み）＝呼び出し側が渡す `deadlineAt`（既定 600 秒ぶん）
 *  3. リトライ待機の上限＝`maxRetryWaitMs`（既定 60 秒。超える待機指示は待たずに失敗）
 *
 * **タイムアウトと「呼び出し側の中断」は別物**として扱う（前者は再試行対象、後者は再試行しない）。
 * 判別は `err.name`（Node/undici の版で `TimeoutError` と `AbortError` が揺れる）に依存せず、
 * 自前の AbortController に持たせた理由（sentinel）と、外部シグナルの aborted 状態で行う。
 *
 * 値フリー：プロンプト・上流の応答ボディをログにもエラーメッセージにも載せない。
 */

import { getRequestLogger } from '../../middleware/requestContext.js';
import {
  JUDGE_MAX_RETRIES,
  JUDGE_RETRY_BASE_DELAY_MS,
  JUDGE_RETRY_JITTER,
  JUDGE_RETRY_MAX_DELAY_MS,
} from './config.js';
import { isJudgeError, JudgeError } from './errors.js';
import type { JudgePrompt } from './prompt.js';
import type { TokenLogprob } from './scoring.js';

/** 自前タイムアウトの abort 理由（`err.name` に依存しない判別のための目印）。 */
const ATTEMPT_TIMEOUT = Symbol('judge.attempt.timeout');

export interface JudgeLlmResult {
  /** 実際に応答したモデル名（応答の model をそのまま返す）。 */
  model: string;
  /** 1 トークン目の候補（token → logprob）。 */
  candidates: TokenLogprob[];
  /** 上流が処理した入力トークン数（切り詰め検知に使う）。上流が返さないこともある。 */
  promptEvalCount?: number;
  /** 生成トークン数（num_predict:1 なので通常 1）。上流が返さないこともある。 */
  evalCount?: number;
}

/** 1 呼び出しの時間制御（リクエスト全体の期限と、呼び出し側の中断シグナル）。 */
export interface JudgeCallOptions {
  /** リクエスト全体の期限（epoch ms）。attemptTimeoutMs とどちらか短い方が効く。 */
  deadlineAt?: number;
  /** 呼び出し側（クライアント切断）の中断シグナル。 */
  signal?: AbortSignal;
}

/** 判定用 LLM seam（unit はフェイク注入）。 */
export interface JudgeLlmClient {
  nextTokenLogprobs(
    prompt: JudgePrompt,
    model: string,
    topK: number,
    options?: JudgeCallOptions,
  ): Promise<JudgeLlmResult>;
}

export interface OllamaNativeClientOptions {
  baseUrl: string;
  /** fetch 1 回のタイムアウト（ms）。 */
  attemptTimeoutMs: number;
  /** リトライ待機の上限（ms）。 */
  maxRetryWaitMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxRetries?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** `[{token, logprob}, ...]` 形の配列を取り出す（それ以外は undefined）。 */
function toTokenLogprobs(value: unknown): TokenLogprob[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: TokenLogprob[] = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    const token = entry?.token;
    const logprob = asNumber(entry?.logprob);
    if (typeof token === 'string' && logprob !== undefined) {
      out.push({ token, logprob });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** logprobs 配列（位置ごと）の先頭要素から、その位置の候補一覧を取り出す。 */
function fromPositions(value: unknown): TokenLogprob[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const first = asRecord(value[0]);
  if (first === undefined) {
    return undefined;
  }
  return toTokenLogprobs(first.top_logprobs) ?? toTokenLogprobs([first]);
}

/**
 * 応答から 1 トークン目の候補を取り出す。Ollama ネイティブの実際の入れ子は版で揺れうるため、
 * 素直な形（top-level / message 配下）を順に試し、OpenAI 互換形も保険として受ける。
 */
function extractCandidates(data: Record<string, unknown>): TokenLogprob[] {
  const message = asRecord(data.message);
  const direct =
    fromPositions(data.logprobs) ??
    fromPositions(message?.logprobs) ??
    fromPositions(asRecord(data.logprobs)?.content) ??
    fromPositions(asRecord(message?.logprobs)?.content);
  if (direct !== undefined) {
    return direct;
  }
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = asRecord(choices[0]);
    const fromChoice = fromPositions(asRecord(choice?.logprobs)?.content) ?? fromPositions(choice?.logprobs);
    if (fromChoice !== undefined) {
      return fromChoice;
    }
  }
  return [];
}

/** `Retry-After`（秒 or HTTP-date）と `retry-after-ms` を ms へ。 */
function retryAfterMs(headers: Headers, now: number): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null) {
    const parsed = Number.parseFloat(ms);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  const after = headers.get('retry-after');
  if (after === null) {
    return undefined;
  }
  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(after);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export class OllamaNativeClient implements JudgeLlmClient {
  private readonly baseUrl: string;
  private readonly attemptTimeoutMs: number;
  private readonly maxRetryWaitMs: number;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxRetries: number;

  constructor(options: OllamaNativeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.attemptTimeoutMs = options.attemptTimeoutMs;
    this.maxRetryWaitMs = options.maxRetryWaitMs;
    this.doFetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.maxRetries = options.maxRetries ?? JUDGE_MAX_RETRIES;
  }

  async nextTokenLogprobs(
    prompt: JudgePrompt,
    model: string,
    topK: number,
    options: JudgeCallOptions = {},
  ): Promise<JudgeLlmResult> {
    const log = getRequestLogger().child({ component: 'api.judge.ollama', model });
    const startedAt = this.now();
    const { deadlineAt, signal } = options;
    const url = `${this.baseUrl}/api/chat`;
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      stream: false,
      think: false,
      logprobs: true,
      top_logprobs: topK,
      // num_ctx / keep_alive は指定しない（モデル読み直しの回避・常駐時間は Ollama 既定に従う）。
      options: { temperature: 0, num_predict: 1 },
    });

    log.debug({ event: 'judge_call_started' }, 'judge call started');

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        throw this.clientAbort(log, startedAt);
      }
      const overallRemaining = deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - this.now();
      if (overallRemaining <= 0) {
        throw this.timeout(log, startedAt);
      }
      const attemptMs = Math.min(this.attemptTimeoutMs, overallRemaining);

      // タイムアウトはボディ読み込みまでを含めて掛ける（ヘッダだけ返して本文が止まる上流で
      // 無限に待たないため、解除は finally＝応答を読み終えた後に行う）。
      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort(ATTEMPT_TIMEOUT), attemptMs);
      // Node 20+ の AbortSignal.any で「自前タイムアウト」と「呼び出し側の中断」を結合する
      // （どちらが発火したかは下で signal の状態を見て判別する＝err.name に依存しない）。
      const combined = signal ? AbortSignal.any([timeoutCtl.signal, signal]) : timeoutCtl.signal;
      let retryHintMs: number | undefined;

      try {
        const res = await this.doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: combined,
        });

        if (!res.ok) {
          const status = res.status;
          // ボディは読み捨てる（プロンプトを反射している可能性があるため、ログにもエラーにも載せない）。
          await res.text().catch(() => '');
          const retryable = status === 408 || status === 429 || status >= 500;
          if (!retryable || attempt >= this.maxRetries) {
            log.error(
              {
                event: 'judge_call_failed',
                code: 'upstream',
                status,
                latency_ms: this.now() - startedAt,
                attempts: attempt + 1,
              },
              'judge call failed',
            );
            throw new JudgeError('upstream', `判定モデルがエラーを返しました（HTTP ${status}）`);
          }
          retryHintMs = retryAfterMs(res.headers, this.now());
        } else {
          let parsed: unknown;
          try {
            parsed = await res.json();
          } catch (err) {
            throw new JudgeError('upstream', '判定モデルの応答を解釈できませんでした', { cause: err });
          }
          const data = asRecord(parsed);
          if (data === undefined) {
            throw new JudgeError('upstream', '判定モデルの応答を解釈できませんでした');
          }

          const candidates = extractCandidates(data);
          if (candidates.length === 0) {
            throw new JudgeError(
              'upstream',
              '判定モデルが logprobs を返しませんでした（ネイティブ /api/chat を叩いているか確認してください）',
            );
          }

          const result: JudgeLlmResult = {
            model: typeof data.model === 'string' && data.model.length > 0 ? data.model : model,
            candidates,
            promptEvalCount: asNumber(data.prompt_eval_count),
            evalCount: asNumber(data.eval_count),
          };
          log.info(
            {
              event: 'judge_call_succeeded',
              latency_ms: this.now() - startedAt,
              attempts: attempt + 1,
              prompt_eval_count: result.promptEvalCount,
              eval_count: result.evalCount,
            },
            'judge call succeeded',
          );
          return result;
        }
      } catch (err) {
        if (isJudgeError(err)) {
          throw err;
        }
        // 呼び出し側の中断が先（再試行しない）。次に自前タイムアウト、最後に接続エラー。
        if (signal?.aborted) {
          throw this.clientAbort(log, startedAt);
        }
        const timedOut = timeoutCtl.signal.aborted && timeoutCtl.signal.reason === ATTEMPT_TIMEOUT;
        if (timedOut) {
          log.warn(
            { event: 'judge_call_attempt_timeout', attempt: attempt + 1, attempt_timeout_ms: Math.round(attemptMs) },
            'judge call attempt timed out',
          );
        }
        if (attempt >= this.maxRetries) {
          if (timedOut) {
            throw this.timeout(log, startedAt, err);
          }
          log.error(
            { event: 'judge_call_failed', code: 'upstream', latency_ms: this.now() - startedAt, attempts: attempt + 1 },
            'judge call failed',
          );
          throw new JudgeError('upstream', '判定モデルに接続できませんでした', { cause: err });
        }
      } finally {
        clearTimeout(timer);
      }

      await this.waitBeforeRetry(attempt, retryHintMs, deadlineAt, startedAt, log);
    }
  }

  private timeout(log: ReturnType<typeof getRequestLogger>, startedAt: number, cause?: unknown): JudgeError {
    log.error(
      { event: 'judge_call_failed', code: 'timeout', latency_ms: this.now() - startedAt },
      'judge call timed out',
    );
    return new JudgeError('timeout', '判定モデルが時間内に応答しませんでした', { cause });
  }

  private clientAbort(log: ReturnType<typeof getRequestLogger>, startedAt: number): JudgeError {
    log.info(
      { event: 'judge_call_aborted', code: 'client_abort', latency_ms: this.now() - startedAt },
      'judge call aborted by client',
    );
    return new JudgeError('client_abort', '呼び出し側が接続を切ったため判定を中断しました');
  }

  /**
   * 次の試行までの待機。上流が指示した待機が上限（maxRetryWaitMs）を超える場合は待たずに失敗させ、
   * 全体予算を超える待機も行わない（タイムアウトへ倒す）。
   */
  private async waitBeforeRetry(
    attempt: number,
    serverHintMs: number | undefined,
    deadlineAt: number | undefined,
    startedAt: number,
    log: ReturnType<typeof getRequestLogger>,
  ): Promise<void> {
    const backoff = Math.min(JUDGE_RETRY_MAX_DELAY_MS, JUDGE_RETRY_BASE_DELAY_MS * 2 ** attempt);
    const jittered = backoff * (1 + (this.random() * 2 - 1) * JUDGE_RETRY_JITTER);
    const delay = Math.max(0, serverHintMs ?? jittered);

    if (delay > this.maxRetryWaitMs) {
      log.error(
        {
          event: 'judge_call_failed',
          code: 'upstream',
          reason: 'retry_wait_too_long',
          delay_ms: Math.round(delay),
          max_retry_wait_ms: this.maxRetryWaitMs,
        },
        'judge call retry wait too long',
      );
      throw new JudgeError(
        'upstream',
        `上流が指示した再試行までの待機（${Math.round(delay)}ms）が上限（${this.maxRetryWaitMs}ms）を超えています`,
      );
    }
    if (deadlineAt !== undefined && this.now() + delay >= deadlineAt) {
      throw this.timeout(log, startedAt);
    }
    log.warn({ event: 'judge_call_retry', attempt: attempt + 1, delay_ms: Math.round(delay) }, 'judge call retry');
    await this.sleep(delay);
  }
}

/**
 * 判定の実行（-onpre 新規・POST /api/judge の本体）。
 *
 * api 側は**判定定義を持たない**（問いの定義・閾値・想定モデルは呼び出し側＝gwr のフロー TOML が持つ）。
 * ここがやるのは「state ＋ 1 問」からプロンプトを組み、1 トークン目の分布を取り、候補へ写像するだけ。
 *
 * 問いは**逐次**に呼ぶ（並列にしない）。state を先頭に置いているため上流のプロンプトキャッシュが効き、
 * 2 問目以降の prompt 評価は実測で約 1/10 になる。並列化するとキャッシュの取り合いになり、
 * 低メモリ機では逆効果になる。
 *
 * 切り詰め検知は二段（どちらも fail-closed）：
 *  1. 送信前：プロンプトの **UTF-8 バイト数**をトークン数の上界として使う（BPE は 1 トークンが最低 1 バイトを
 *     消費するため、バイト数 ≥ トークン数が常に成り立つ）。上流の挙動に一切依存しない厳密に安全側の判定。
 *  2. 送信後：`prompt_eval_count` がコンテキスト長の上限付近なら中断。キャッシュ再利用時にこの値が
 *     「新規処理分だけ」になる版があっても、その場合は発火しないだけで 1. の保証は崩れない
 *     （＝多めに止める方向にしか働かない）。
 */

import { JUDGE_RESERVE_TOKENS, JUDGE_TOP_LOGPROBS, type JudgeConfig } from './config.js';
import { JudgeError } from './errors.js';
import type { JudgeLlmClient } from './ollamaNativeClient.js';
import {
  buildPrompt,
  type JudgeOption,
  type JudgePrompt,
  type JudgeQuestion,
  optionTokens,
  questionOptions,
  serializeState,
  stripStateCloseTag,
} from './prompt.js';
import { expectedScore, scoreCandidates } from './scoring.js';
import { getRequestLogger } from '../../middleware/requestContext.js';

export interface JudgeAnswerNoul {
  type: 'noul';
  noul: boolean;
}

export interface JudgeAnswerChoice {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JudgeAnswerScore {
  type: 'score';
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
  legend: Record<string, string>;
}

export type JudgeAnswer = JudgeAnswerNoul | JudgeAnswerChoice | JudgeAnswerScore;

export interface JudgeRequest {
  state: unknown;
  questions: Record<string, JudgeQuestion>;
  /** リクエスト指定モデル（任意）。許可リスト外は 400、未指定は既定モデル。 */
  model?: string;
  /** 呼び出し側の中断シグナル（クライアント切断）。中断は再試行しない。 */
  signal?: AbortSignal;
}

export interface JudgeResult {
  /** 実際に応答したモデル名（gwr 側で想定モデルと照合するため、既定へ委譲した場合も実名を返す）。 */
  model: string;
  answers: Record<string, JudgeAnswer>;
  /**
   * トークン数。上流が返さないことがあるため**欠落しうる**（その場合はフィールドごと省く。
   * 例外にはしない）。値そのものはログに出さない。
   */
  usage: { input_tokens?: number; output_tokens?: number };
}

export class JudgeService {
  constructor(
    private readonly llm: JudgeLlmClient,
    private readonly config: JudgeConfig,
    /** 時刻取得（unit で予算切れを再現するため注入可）。 */
    private readonly now: () => number = Date.now,
  ) {}

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    const log = getRequestLogger().child({ component: 'api.judge' });
    const model = this.resolveModel(request.model);
    const stateText = this.prepareState(request.state);

    const answers: Record<string, JudgeAnswer> = {};
    // トークン数は欠落しうる。1 問でも欠けたらそのフィールドは出さない（合計が嘘になるため）。
    let inputTokens: number | undefined = 0;
    let outputTokens: number | undefined = 0;
    let actualModel = model;
    // リクエスト全体（全問・リトライ・待機を含む）の予算。問いの数だけ推論が走るため、
    // 1 問ごとの上限だけでは全体が伸び続ける。
    const deadlineAt = this.now() + this.config.requestBudgetMs;

    for (const [name, question] of Object.entries(request.questions)) {
      if (request.signal?.aborted) {
        throw new JudgeError('client_abort', '呼び出し側が接続を切ったため判定を中断しました');
      }
      if (this.now() >= deadlineAt) {
        throw new JudgeError('timeout', '判定が時間内に終わりませんでした');
      }

      const options = questionOptions(question);
      const tokens = optionTokens(options);
      const prompt = buildPrompt(stateText, question);
      this.assertFitsContext(prompt);

      const res = await this.llm.nextTokenLogprobs(prompt, model, JUDGE_TOP_LOGPROBS, {
        deadlineAt,
        signal: request.signal,
      });
      this.assertNotTruncated(res.promptEvalCount);

      inputTokens = res.promptEvalCount === undefined ? undefined : (inputTokens ?? 0) + res.promptEvalCount;
      outputTokens = res.evalCount === undefined ? undefined : (outputTokens ?? 0) + res.evalCount;
      actualModel = res.model;

      // 値フリー：ここから先（確率・答え）はログに出さない。
      answers[name] = toAnswer(question, options, scoreCandidates(res.candidates, tokens));
    }

    log.info(
      {
        event: 'judge_completed',
        model: actualModel,
        questions: Object.keys(request.questions).length,
      },
      'judge completed',
    );

    return {
      model: actualModel,
      answers,
      usage: {
        ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
        ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
      },
    };
  }

  /** 許可リスト照合。未設定（既定モデルも許可リストも無い）はこのルートだけ 503。 */
  private resolveModel(requested?: string): string {
    if (this.config.allowedModels.length === 0) {
      throw new JudgeError(
        'model_unavailable',
        '判定モデルが設定されていません（JUDGE_DEFAULT_MODEL もしくは OLLAMA_DEFAULT_CHAT_MODEL を設定してください）',
      );
    }
    if (requested !== undefined) {
      if (!this.config.allowedModels.includes(requested)) {
        throw new JudgeError('model_not_allowed', 'このモデルは使用できません。');
      }
      return requested;
    }
    if (this.config.defaultModel === undefined) {
      throw new JudgeError(
        'model_unavailable',
        '判定モデルが設定されていません（JUDGE_DEFAULT_MODEL もしくは OLLAMA_DEFAULT_CHAT_MODEL を設定してください）',
      );
    }
    return this.config.defaultModel;
  }

  /** state を文字列化し、閉じタグを除去したうえで上限バイト数を検査する。 */
  private prepareState(state: unknown): string {
    const text = this.serializeStateOrReject(state);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.config.maxStateBytes) {
      // 値フリー：超過したサイズは出すが、state 本文は出さない。
      throw new JudgeError(
        'state_too_large',
        `state が上限を超えています（${bytes} バイト > ${this.config.maxStateBytes} バイト）`,
      );
    }
    return stripStateCloseTag(text);
  }

  /**
   * state の文字列化。**state に入れ子の深さの上限は掛けない**（criteria・instructions と違って
   * インデント膨張は 422 で受け止められるため）。代わりに `JSON.stringify` が `RangeError` を投げた
   * ときだけ 400 にする：
   *  - `Maximum call stack size exceeded`（V8 の再帰が溢れるほど深い入れ子）
   *  - `Invalid string length`（文字列化の結果が V8 の文字列長上限を超える）
   *
   * どちらも「送られた state が処理できない」という入力側の問題で、サーバの不具合ではない。
   * **`RangeError` 以外は握りつぶさない**（従来どおり 500 になる）。
   */
  private serializeStateOrReject(state: unknown): string {
    try {
      return serializeState(state);
    } catch (error) {
      if (error instanceof RangeError) {
        // 値フリー：state 本文は載せない（原因の RangeError の message は V8 の固定文言のみ）。
        throw new JudgeError('state_not_serializable', 'state の入れ子が深すぎます（文字列にできませんでした）', {
          cause: error,
        });
      }
      throw error;
    }
  }

  /** 送信前の上界判定（UTF-8 バイト数 ≥ トークン数）。 */
  private assertFitsContext(prompt: JudgePrompt): void {
    const upperBound = Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
    if (upperBound + JUDGE_RESERVE_TOKENS > this.config.contextLength) {
      throw new JudgeError(
        'context_overflow',
        `入力がコンテキスト長（${this.config.contextLength}）を超える恐れがあります。黙って切り詰められるのを避けるため中断しました`,
      );
    }
  }

  /** 送信後の検知（上流が実際に処理した入力トークン数）。 */
  private assertNotTruncated(promptEvalCount?: number): void {
    if (promptEvalCount !== undefined && promptEvalCount >= this.config.contextLength - JUDGE_RESERVE_TOKENS) {
      throw new JudgeError(
        'context_overflow',
        `入力がコンテキスト長（${this.config.contextLength}）の上限付近に達しました。切り詰めの恐れがあるため中断しました`,
      );
    }
  }
}

function toAnswer(
  question: JudgeQuestion,
  options: JudgeOption[],
  scored: { probabilities: Record<string, number>; top: string; confidence: number },
): JudgeAnswer {
  switch (question.type) {
    case 'noul':
      return { type: 'noul', noul: scored.top === 'Yes' };
    case 'choice': {
      // 公開ラベル（criteria がオブジェクト形式なら呼び出し側のキー、配列形式なら記号そのもの）へ読み替える。
      const labelOf = (token: string) => options.find((o) => o.token === token)?.label ?? token;
      const probabilities: Record<string, number> = {};
      for (const option of options) {
        probabilities[option.label] = scored.probabilities[option.token] ?? 0;
      }
      return {
        type: 'choice',
        choice: labelOf(scored.top),
        probabilities,
        confidence: scored.confidence,
      };
    }
    case 'score':
      return {
        type: 'score',
        score: expectedScore(
          scored.probabilities,
          options.map((o) => o.token),
        ),
        probabilities: scored.probabilities,
        confidence: scored.confidence,
        legend: Object.fromEntries(options.map((o) => [o.token, o.description ?? ''])),
      };
  }
}

import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { ApiError } from '../../lib/http/errors.js';
import { parseBody } from '../../lib/http/validation.js';
import type { JudgeErrorCode } from '../../lib/judge/errors.js';
import { isJudgeError } from '../../lib/judge/errors.js';
import type { JudgeDeps } from './deps.js';
import { judgeSchema } from './schemas.js';

/**
 * 判定（POST /api/judge・-onpre 新規）。
 *
 * 判定定義（問い・閾値・想定モデル）は呼び出し側が持ち、api は状態を持たない。
 * 応答の `model` には**実際に応答したモデル名**を入れる（呼び出し側が想定モデルと照合するため）。
 *
 * 判定結果は「許可」の根拠に使わない前提（認可は requireAuth／requireUseCase／authz が担い、
 * 判定はあくまでフロー分岐のための確率的な材料）。
 *
 * 値フリー：state 本文・確率値はログにもエラー応答にも出さない。
 */

/** lib 層の失敗種別 → HTTP status（既存 errorHandler が {error:message} に整形する）。 */
const STATUS_BY_CODE: Record<JudgeErrorCode, number> = {
  // 入力側の問題は既存 parseBody の流儀（400）に合わせる。
  state_too_large: 400,
  state_not_serializable: 400,
  model_not_allowed: 400,
  // 切り詰めの恐れ（fail-closed）。
  context_overflow: 422,
  // 上流（Ollama）起因。候補が圏外も「上流が使える答えを返さなかった」として 502。
  upstream: 502,
  no_candidate: 502,
  // 判定モデル未設定（このルートだけ塞ぐ）。
  model_unavailable: 503,
  timeout: 504,
  // 呼び出し側が切った場合は応答先がいない（下で特別扱いし、この値は使わない）。
  client_abort: 499,
};

export function createJudgeHandler(deps: JudgeDeps): RequestHandler {
  return createApiHandler(async ({ req, res, log }) => {
    const body = parseBody(judgeSchema, req.body);

    // クライアント切断の検出（Express 5）。正常終了と区別するため writableEnded を見る。
    // 中断は「上流が遅い（タイムアウト）」とは別物で、再試行せず上流への fetch も即座に止める。
    const aborted = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) {
        aborted.abort();
      }
    };
    res.on('close', onClose);

    try {
      const result = await deps.judge.judge({
        state: body.state,
        questions: body.questions,
        model: body.model,
        signal: aborted.signal,
      });
      return { status: 200, body: result };
    } catch (error) {
      if (isJudgeError(error) && error.code === 'client_abort') {
        // 値フリーで 1 行だけ残し、ステータスは設定せずに終える（応答を受け取る相手がいない）。
        log.info({ event: 'judge_client_aborted' }, 'judge request aborted by client');
        res.on('error', () => {
          /* 切断済みソケットへの遅延書き込みエラーは握りつぶす。 */
        });
        if (!res.writableEnded) {
          res.end();
        }
        return { status: STATUS_BY_CODE.client_abort };
      }
      if (isJudgeError(error)) {
        // 上流 errorHandler が status + {error:message} に整形する（image ルートと同流儀）。
        throw new ApiError(STATUS_BY_CODE[error.code], error.message);
      }
      throw error;
    } finally {
      res.off('close', onClose);
    }
  });
}

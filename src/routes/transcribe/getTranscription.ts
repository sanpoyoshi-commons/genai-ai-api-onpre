import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { forbidden, notFound } from '../../lib/http/errors.js';
import { requirePathParam } from '../../lib/http/validation.js';
import type { GetTranscriptionResponse } from '../../types/genaiWeb.js';
import type { TranscribeDeps } from './deps.js';

/**
 * getTranscription（GET /transcribe/result/{jobName}、MIT 移植）。ジョブ状態を取得し、所有権（起票 userId 一致）を
 * 確認して返す。COMPLETED 時は languageCode＋話者マージ済み transcripts、それ以外は status のみ。
 * 他ユーザーのジョブは 403、不在は 404。transcript 正規化はバックエンド側（TranscriptionClient seam）に閉じる。
 */
export function createGetTranscriptionHandler(deps: TranscribeDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const jobName = requirePathParam(req, 'jobName');

    const job = await deps.transcription.getJob(jobName);
    if (!job) {
      throw notFound('文字起こしジョブが見つかりません。');
    }
    if (job.ownerUserId !== auth.userId) {
      throw forbidden('Forbidden');
    }

    const response: GetTranscriptionResponse =
      job.transcripts !== undefined
        ? { status: job.status, languageCode: job.languageCode, transcripts: job.transcripts }
        : { status: job.status };
    return { status: 200, body: response };
  });
}

import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { forbidden } from '../../lib/http/errors.js';
import { parseBody } from '../../lib/http/validation.js';
import { authorizeOwnedKey } from '../../lib/storage/ownership.js';
import type { TranscribeDeps } from './deps.js';
import { startTranscriptionSchema } from './schemas.js';

/**
 * startTranscription（POST /transcribe/start、MIT 移植）。audioKey の所有権（プレフィックス一致）を確認してから
 * 文字起こしジョブを起票し、jobName を返す。所有権は auth.userId に読み替え。
 * バックエンド（Whisper 系）と状態管理は TranscriptionClient seam（後続配線）。
 */
export function createStartTranscriptionHandler(deps: TranscribeDeps): RequestHandler {
  return createApiHandler(async ({ req, auth }) => {
    const { audioKey, speakerLabel, maxSpeakers } = parseBody(startTranscriptionSchema, req.body);

    if (!authorizeOwnedKey(audioKey, auth.userId)) {
      throw forbidden('Access denied: You can only transcribe your own files');
    }

    const { jobName } = await deps.transcription.startJob({
      audioKey,
      speakerLabel,
      maxSpeakers,
      userId: auth.userId,
    });
    return { status: 200, body: { jobName } };
  });
}

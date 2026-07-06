import { TranscriptionError } from './errors.js';

/**
 * 文字起こしバックエンド設定（LlmConfig／ImageConfig と対称）。
 *
 * `TRANSCRIPTION_BACKEND`（既定 faster-whisper）で経路を選ぶ。現状は faster-whisper-server（speaches、
 * OpenAI 互換 /v1/audio/transcriptions）のみ実装。非秘密は既定値・秘密なし（speaches は
 * 認証なし）＝個人開発者の `.env` 最小設定を保つ。lazy 読込（worker が使用時に呼ぶ＝未配線でも起動可）。
 */
export interface TranscriptionConfig {
  /** 経路。現状は 'faster-whisper' のみ。 */
  backend: string;
  /** speaches のベース URL（/v1 の手前まで。openai SDK は baseURL に /v1 を含めるため付与済みを渡す）。 */
  baseURL: string;
  /** 使用モデル（speaches は HF リポ名指定、例 'Systran/faster-whisper-large-v3'）。 */
  model: string;
  /** 言語ヒント（空なら自動検出）。CPU 速度・精度の調整余地として env 化。 */
  language?: string;
  /** 文字起こし HTTP のタイムアウト（ms）。CPU 推論の長尺を見込む。 */
  timeoutMs: number;
}

const DEFAULT_BASE_URL = 'http://whisper:8000/v1';
const DEFAULT_MODEL = 'Systran/faster-whisper-large-v3';
const DEFAULT_TIMEOUT_MS = 600_000; // 10 分（CPU 推論の長尺音声を見込む）

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function loadTranscriptionConfig(env: NodeJS.ProcessEnv = process.env): TranscriptionConfig {
  const backend = (env.TRANSCRIPTION_BACKEND ?? 'faster-whisper').trim().toLowerCase();
  const timeoutMs = parsePositiveInt(env.WHISPER_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const language = env.WHISPER_LANGUAGE?.trim() || undefined;

  switch (backend) {
    case 'faster-whisper':
      return {
        backend,
        baseURL: env.WHISPER_BASE_URL?.trim() || DEFAULT_BASE_URL,
        model: env.WHISPER_MODEL?.trim() || DEFAULT_MODEL,
        language,
        timeoutMs,
      };
    default:
      throw new TranscriptionError({
        code: 'INTERNAL',
        backend,
        message: `TRANSCRIPTION_BACKEND='${backend}' は未対応です（現状は faster-whisper-server＝'faster-whisper' のみ）`,
      });
  }
}

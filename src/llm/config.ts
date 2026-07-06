import { LLMError } from './errors.js';

/**
 * 経路設定の読込（openai 互換経路）。
 *
 * `LLM_BACKEND`（既定 ollama）で経路を選び、経路ごとの env から baseURL/apiKey/既定モデルを組み立てる。
 * 対応経路は openai 互換 1 アダプタで吸収できる ollama/vllm/openai（ローカル/汎用）＋ anthropic/gemini
 * （いずれも OpenAI 互換エンドポイントを公開）と、SigV4 認証で専用アダプタが要る bedrock（Converse API・
 * AWS SDK 既定クレデンシャルチェーン）。`.env` 1 行（LLM_BACKEND）切替を保つため、非秘密は
 * 既定値・秘密（cloud の API キー）のみ必須にする。lazy 読込（factory が使用時に呼ぶ）＝未配線でも
 * app 起動可・使用時に例外（seam と同挙動）。
 */
export interface LlmConfig {
  /** 経路。'ollama' | 'vllm' | 'openai' | 'anthropic' | 'gemini'（openai 互換）| 'bedrock'（Converse）。 */
  backend: string;
  /** OpenAI 互換エンドポイント（/v1 まで含む）。bedrock は SDK が region 解決するため未使用（空）。 */
  baseURL: string;
  /** API キー。認証なし経路（ollama/vllm）はダミー。bedrock は SigV4＝未使用（空）。 */
  apiKey: string;
  /** AWS リージョン（bedrock 専用。SDK のエンドポイント解決に必須）。他経路は undefined。 */
  region?: string;
  /** 既定チャットモデル。ChatInput.model が空のとき使用。 */
  defaultModel?: string;
  /**
   * 既定 max_tokens。リクエスト未指定時にアダプタが補う。anthropic 互換レイヤーは max_tokens を
   * 必須とするため anthropic 経路のみ設定する（未指定 400 回避）。他経路は undefined＝省略のまま。
   */
  defaultMaxTokens?: number;
  /** 既定タイムアウト（ms）。 */
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 分（CPU 推論で重いモデル/大きいプロンプトの完走余地。env LLM_DEFAULT_TIMEOUT_MS で上書き可）

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string, backend: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new LLMError({
      code: 'AUTHENTICATION',
      backend,
      message: `${backend} 経路には環境変数 ${key} が必要です`,
    });
  }
  return value;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const backend = (env.LLM_BACKEND ?? 'ollama').trim().toLowerCase();
  const timeoutMs = parsePositiveInt(env.LLM_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

  switch (backend) {
    case 'ollama':
      return {
        backend,
        baseURL: env.OLLAMA_BASE_URL?.trim() || 'http://ollama:11434/v1',
        apiKey: 'ollama', // 認証なし。SDK が非空 apiKey を要求するためのダミー（not-used 相当）。
        defaultModel: env.OLLAMA_DEFAULT_CHAT_MODEL?.trim() || undefined,
        timeoutMs,
      };
    case 'vllm':
      return {
        backend,
        baseURL: env.VLLM_BASE_URL?.trim() || 'http://vllm:8000/v1',
        apiKey: 'vllm',
        defaultModel: env.VLLM_DEFAULT_CHAT_MODEL?.trim() || undefined,
        timeoutMs,
      };
    case 'openai':
      return {
        backend,
        baseURL: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
        apiKey: requireEnv(env, 'OPENAI_API_KEY', backend),
        defaultModel: env.OPENAI_DEFAULT_CHAT_MODEL?.trim() || 'gpt-4o-mini',
        timeoutMs,
      };
    case 'anthropic':
      // Anthropic の OpenAI 互換レイヤー（/v1/chat/completions）。openai SDK を baseURL 差し替えで流用。
      // 互換レイヤーは max_tokens を必須とするため defaultMaxTokens を与える（未指定リクエストの 400 回避）。
      // 既定モデルは cloud の常で随時更新されるため env 上書き可（運用者が .env で指定する前提の保守的既定）。
      return {
        backend,
        baseURL: env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com/v1',
        apiKey: requireEnv(env, 'ANTHROPIC_API_KEY', backend),
        defaultModel: env.ANTHROPIC_DEFAULT_CHAT_MODEL?.trim() || 'claude-3-5-haiku-latest',
        defaultMaxTokens: parsePositiveInt(env.ANTHROPIC_MAX_TOKENS) ?? 4096,
        timeoutMs,
      };
    case 'gemini':
      // Gemini の OpenAI 互換レイヤー（/v1beta/openai/chat/completions）。max_tokens は任意なので既定不要。
      return {
        backend,
        baseURL:
          env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: requireEnv(env, 'GEMINI_API_KEY', backend),
        defaultModel: env.GEMINI_DEFAULT_CHAT_MODEL?.trim() || 'gemini-1.5-flash',
        timeoutMs,
      };
    case 'bedrock': {
      // Bedrock は SigV4＝OpenAI 互換不可。専用 bedrockAdapter（Converse API）が消費する。認証は AWS SDK の
      // 既定クレデンシャルチェーン（env の AWS_ACCESS_KEY_ID/SECRET[/SESSION_TOKEN]・IAM ロール・プロファイル）
      // に委ね、本 config は region のみ必須化する（SDK は region 未解決だと送信不可）。baseURL/apiKey は本経路
      // で未使用（IF 共通のため空）。既定モデルは env 上書き可（cloud ID は随時更新・新しめのモデルは推論プロファイル
      // ID が要る場合があるため運用者が .env で指定する前提の保守的既定）。
      const region = env.BEDROCK_REGION?.trim() || env.AWS_REGION?.trim();
      if (!region) {
        throw new LLMError({
          code: 'INVALID_REQUEST',
          backend,
          message: 'bedrock 経路には環境変数 BEDROCK_REGION（または AWS_REGION）が必要です',
        });
      }
      return {
        backend,
        baseURL: '',
        apiKey: '',
        region,
        defaultModel:
          env.BEDROCK_DEFAULT_CHAT_MODEL?.trim() || 'anthropic.claude-3-5-haiku-20241022-v1:0',
        defaultMaxTokens: parsePositiveInt(env.BEDROCK_MAX_TOKENS) ?? 4096,
        timeoutMs,
      };
    }
    default:
      throw new LLMError({
        code: 'NOT_IMPLEMENTED',
        backend,
        message: `LLM_BACKEND='${backend}' は未対応です（対応経路は openai 互換の ollama/vllm/openai/anthropic/gemini と bedrock）`,
      });
  }
}

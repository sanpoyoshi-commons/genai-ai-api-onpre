import pino from 'pino';

/**
 * 固定秘匿パスリスト（OWASP「ログに直接記録しないリスト」対応）。
 * コード固定（ユーザー入力から構築しない＝fast-redact 攻撃ベクトル回避）。
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwd',
  '*.secret',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.api_key',
  '*.session_id',
  '*.connection_string',
  '*.private_key',
];

/**
 * 共有 pino ロガー（ログ計装方針の推奨初期設定）。
 *
 * - level: LOG_LEVEL で出力レベルを制御
 * - JSON 構造化 1 行 1 イベント
 * - formatters.level: 数値ではなく大文字文字列（OTel SeverityText 互換）
 * - messageKey: 'body'（OTel Logs Data Model の Body フィールド互換）
 * - timestamp: ISO 8601（pino デフォルトの ms epoch ではなく時刻列の可読性優先）
 * - base: service / env を全レコードに付与（必須フィールド）
 * - redact: 秘匿パスをコード固定で censor
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.LOG_SERVICE_NAME ?? 'genai-local-api',
    env: process.env.NODE_ENV ?? 'development',
  },
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  messageKey: 'body',
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
});

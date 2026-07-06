import { SQSClient } from '@aws-sdk/client-sqs';
import type { QueueConfig } from './config.js';

/**
 * SQS 互換クライアント（ElasticMQ をエンドポイント差替で利用）。
 * ElasticMQ は認証情報を検証しないため、AWS SDK の credentials 必須要件を満たす
 * ローカル固定のダミー値を既定とする。本番 AWS SQS へ向ける場合は env 経由の
 * 標準クレデンシャルチェーンへ差し替える（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY）。
 */
export function createSqsClient(config: QueueConfig): SQSClient {
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
    },
  });
}

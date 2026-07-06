/**
 * 非同期キュー（ElasticMQ／SQS 互換）の接続設定。
 * ElasticMQ を採用し、ExApp 配線・文字起こしで transcribe キューを追加する。
 * env（SQS_ENDPOINT / AWS_REGION / EXAPP_QUEUE_URL / TRANSCRIBE_QUEUE_URL）から読む。
 * endpoint/region/creds は ExApp と文字起こしで共有（同一 ElasticMQ）、キュー URL のみ機能別。
 */
export interface QueueConfig {
  endpoint: string;
  region: string;
  /** ExApp 非同期実行キュー（pollExAppStatus）。 */
  queueUrl: string;
  /** 文字起こし非同期ジョブキュー（pollTranscriptionStatus）。 */
  transcribeQueueUrl: string;
}

/**
 * 必須 env が欠けていれば起動時に失敗させる（無設定での暗黙起動を防ぐ）。
 */
export function loadQueueConfig(): QueueConfig {
  const endpoint = process.env.SQS_ENDPOINT;
  const region = process.env.AWS_REGION;
  const queueUrl = process.env.EXAPP_QUEUE_URL;
  const transcribeQueueUrl = process.env.TRANSCRIBE_QUEUE_URL;
  if (!endpoint || !region || !queueUrl || !transcribeQueueUrl) {
    throw new Error(
      'queue config missing: SQS_ENDPOINT / AWS_REGION / EXAPP_QUEUE_URL / TRANSCRIBE_QUEUE_URL must be set',
    );
  }
  return { endpoint, region, queueUrl, transcribeQueueUrl };
}

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/**
 * 受信したジョブの正規化形（消費側が扱う最小フィールド）。
 */
export interface ReceivedJob {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** ApproximateReceiveCount（再受信回数）。バックオフ判定に用いる。 */
  receiveCount: number;
}

/**
 * ExApp 非同期実行キューの操作ラッパ。
 * SQS の send / receive（疑似ロングポーリング）/
 * delete / changeVisibility をローカル ElasticMQ へ写像する。
 * 関数名・エラー文字列は本リポ独自命名。
 */
export class ExAppQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  /** 非同期実行ジョブをキューへ投入（SendMessage）。 */
  async enqueueJob(body: string): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: body }));
  }

  /**
   * ジョブを 1 件受信（疑似ロングポーリング、batchSize=1 相当）。
   * ApproximateReceiveCount を取得しバックオフ判定に渡す。受信なしは null。
   */
  async receiveJob(waitTimeSeconds: number): Promise<ReceivedJob | null> {
    const out: ReceiveMessageCommandOutput = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const message = out.Messages?.[0];
    if (!message?.ReceiptHandle) {
      return null;
    }
    return {
      messageId: message.MessageId ?? '',
      receiptHandle: message.ReceiptHandle,
      body: message.Body ?? '',
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
    };
  }

  /** 処理完了したジョブを削除（DeleteMessage）。 */
  async completeJob(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }

  /**
   * 未完了ジョブの可視性タイムアウトを延長（ChangeMessageVisibility による動的バックオフ）。
   * 削除しないため、可視性経過後に再配信される（リトライ駆動）。
   */
  async deferJob(receiptHandle: string, visibilitySeconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilitySeconds,
      }),
    );
  }
}

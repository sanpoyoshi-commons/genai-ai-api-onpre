import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FileStorage, PresignDownloadOptions } from './fileStorage.js';
import { loadS3Config, type S3Config } from './s3Config.js';

/**
 * FileStorage seam の実装＝SeaweedFS（S3 互換）アダプタ（skeleton 実装の置換）。
 *
 * seam（presignUpload/presignDownload/deleteObject）を維持し、消費ルート（file #15-17・transcribe #19・
 * artifact #44）と ownership/extraData は無改修。presign は公開エンドポイント client で SigV4 署名（ブラウザ直
 * I/O・上流互換）、deleteObject は内部 client で直送（2 client 分離）。client は lazy 生成（未配線でも
 * app 起動可・初回使用時に config 解決＝KeycloakIdpClient/LlmAbstractionClient と同方式）。unit は requestHandler
 * 注入の実 client を渡す（presign は純 SigV4 計算で network 不要・delete は注入 handler で検証）。
 */
export class SeaweedFsStorage implements FileStorage {
  private publicClient?: S3Client;
  private internalClient?: S3Client;

  /** unit は pre-built client を注入。未指定は env から lazy 生成。 */
  constructor(clients?: { publicClient?: S3Client; internalClient?: S3Client }) {
    this.publicClient = clients?.publicClient;
    this.internalClient = clients?.internalClient;
  }

  /** presign 用（公開エンドポイント署名）。S3_PUBLIC_ENDPOINT 未設定は使用時に明示エラー。 */
  private getPublic(): S3Client {
    if (!this.publicClient) {
      const config = loadS3Config();
      if (!config.publicEndpoint) {
        throw new Error(
          'presigned URL の生成には環境変数 S3_PUBLIC_ENDPOINT（ブラウザ到達用・prefix なし）が必要です',
        );
      }
      this.publicClient = createClient(config, config.publicEndpoint);
    }
    return this.publicClient;
  }

  /** delete 用（内部直結）。公開エンドポイント無しでも動作する。 */
  private getInternal(): S3Client {
    if (!this.internalClient) {
      const config = loadS3Config();
      this.internalClient = createClient(config, config.internalEndpoint);
    }
    return this.internalClient;
  }

  presignUpload(bucket: string, key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.getPublic(), new PutObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn,
    });
  }

  presignDownload(bucket: string, key: string, options: PresignDownloadOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: options.responseContentType,
      ResponseContentDisposition: options.responseContentDisposition,
    });
    return getSignedUrl(this.getPublic(), command, { expiresIn: options.expiresIn });
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array> {
    const res = await this.getInternal().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) {
      throw new Error(`オブジェクト本体が空です（bucket=${bucket} key=${key}）`);
    }
    // AWS SDK v3 の SdkStream はバイト列化ヘルパを持つ（Node の Readable を一括バッファ化）。
    return res.Body.transformToByteArray();
  }

  async putObject(bucket: string, key: string, body: Uint8Array, contentType?: string): Promise<void> {
    await this.getInternal().send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    try {
      await this.getInternal().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      // 冪等想定（seam 契約）。存在しないキーは成功扱いにする。
      if (isNoSuchKey(err)) {
        return;
      }
      throw err;
    }
  }
}

function createClient(config: S3Config, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true, // SeaweedFS は virtual-host 形式を取らないため path-style 必須。
    // AWS SDK v3（3.729+）は PutObject に既定で CRC32 チェックサムを自動付与するが、presigned URL 経路で
    // SeaweedFS が BadDigest を返すため抑止する（S3 互換ストア共通の対処）。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function isNoSuchKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

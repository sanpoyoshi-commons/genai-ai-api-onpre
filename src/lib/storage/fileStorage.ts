/**
 * オブジェクトストレージの seam（seam 注入＋実 SeaweedFS 配線は後続）。
 *
 * 上流は AWS S3（PutObject/GetObject presigned URL、DeleteObject）でファイルを扱う。ローカルは
 * SeaweedFS 4.22（S3 互換）に `@aws-sdk/client-s3` ＋ `@aws-sdk/s3-request-presigner`
 * で対応する。presign 自体はローカル計算だが依存追加と接続 env が要るため、ここでは
 * インターフェースのみ定義して deps 注入し、実 S3 アダプタは後続で配線する（idp/apiKey と同方式）。
 * unit テストは fake を注入する。バケット名は呼び出し側（config）が解決して bucket 引数で渡す。
 */

export interface PresignDownloadOptions {
  /** 署名 URL の有効秒数。 */
  expiresIn: number;
  /** レスポンスの Content-Type 上書き（任意、上流互換）。 */
  responseContentType?: string;
  /** レスポンスの Content-Disposition（artifact は 'attachment'）。 */
  responseContentDisposition?: string;
}

export interface FileStorage {
  /** アップロード用 presigned URL（PutObject 相当）。 */
  presignUpload(bucket: string, key: string, expiresIn: number): Promise<string>;
  /** ダウンロード用 presigned URL（GetObject 相当）。 */
  presignDownload(bucket: string, key: string, options: PresignDownloadOptions): Promise<string>;
  /**
   * オブジェクト本体をバイト列で取得する（GetObject 相当・内部直結）。
   * worker（文字起こし）が音声を取得して Whisper へ送るのに使う。不在は NoSuchKey 系の例外。
   */
  getObject(bucket: string, key: string): Promise<Uint8Array>;
  /**
   * オブジェクト本体を書き込む（PutObject 相当・内部直結）。
   * worker（ExApp）が外部 API の artifacts(base64)・大容量 outputs を退避するのに使う。
   */
  putObject(bucket: string, key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** オブジェクト削除（DeleteObject 相当・冪等想定）。 */
  deleteObject(bucket: string, key: string): Promise<void>;
}

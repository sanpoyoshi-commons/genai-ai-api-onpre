/**
 * SeaweedFS（S3 互換）接続設定（専用エンドポイント方式）。
 *
 * presigned URL の SigV4 署名は host＋path＋ブラウザ実 URL＋SeaweedFS 受信 path の一致を要するため、
 * presign は「ブラウザから到達できる公開エンドポイント」(`S3_PUBLIC_ENDPOINT`、prefix なし＝専用サブドメイン/
 * ポート)で署名し、サーバ側 deleteObject は内部直結(`S3_INTERNAL_ENDPOINT`、既定 `seaweedfs:8333`)で送る
 * （2 client 分離）。SeaweedFS は `-s3.config` で認証を効かせるため SDK は専用 creds で SigV4
 * 署名する。非秘密は既定値・creds と公開エンドポイントは env 必須。lazy 読込（未配線でも app 起動可・使用時に例外
 * ＝llm config と同方式）。バケット名は呼び出し側（`config.ts`）が解決して bucket 引数で渡す。
 */

import { readSecretEnv } from '../secretEnv.js';

const DEFAULT_INTERNAL_ENDPOINT = 'http://seaweedfs:8333';
const DEFAULT_REGION = 'us-east-1'; // SeaweedFS は region を検証しないが SDK が SigV4 に要求するダミー。

/** S3 クライアント生成に必要な接続情報。public/internal で endpoint のみ異なり creds/region は共通。 */
export interface S3Config {
  /** ブラウザ到達用エンドポイント（presign 署名対象、prefix なし）。presign 利用時に必須。 */
  publicEndpoint?: string;
  /** 内部直結エンドポイント（deleteObject 用）。 */
  internalEndpoint: string;
  /** リージョン（SigV4 用ダミー可）。 */
  region: string;
  /** アクセスキー ID（SeaweedFS s3.config の identity）。 */
  accessKeyId: string;
  /** シークレットアクセスキー。 */
  secretAccessKey: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`オブジェクトストレージ（SeaweedFS）には環境変数 ${key} が必要です`);
  }
  return value;
}

/** 機微値を `${key}_FILE`（docker secrets）優先で読む。未設定なら例外。 */
function requireSecret(env: NodeJS.ProcessEnv, key: string): string {
  const value = readSecretEnv(env, key);
  if (!value) {
    throw new Error(`オブジェクトストレージ（SeaweedFS）には環境変数 ${key}（または ${key}_FILE）が必要です`);
  }
  return value;
}

export function loadS3Config(env: NodeJS.ProcessEnv = process.env): S3Config {
  return {
    publicEndpoint: env.S3_PUBLIC_ENDPOINT?.trim() || undefined,
    internalEndpoint: env.S3_INTERNAL_ENDPOINT?.trim() || DEFAULT_INTERNAL_ENDPOINT,
    region: env.S3_REGION?.trim() || DEFAULT_REGION,
    accessKeyId: requireEnv(env, 'S3_ACCESS_KEY_ID'),
    // 機微：docker secrets（S3_SECRET_ACCESS_KEY_FILE）優先・素の env フォールバック（ハードニング）。
    secretAccessKey: requireSecret(env, 'S3_SECRET_ACCESS_KEY'),
  };
}

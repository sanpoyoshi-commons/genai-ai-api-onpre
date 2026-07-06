import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * ExApp apiKey のアプリ層暗号化（AES-256-GCM）。
 *
 * EXAPP_APIKEY_ENC_KEY（32 バイト鍵を base64／hex で指定）が設定されている場合のみ有効化する。
 * localhost 単一運用前提の最小実装：鍵管理・ローテーションは行わない（最小要件）。
 * 暗号文は `<ciphertext||authTag>` を base64 で value に、IV(12B) を base64 で enc_iv に格納する
 * （PostgresApiKeyStore がカラムへ写像）。enc_iv の有無で平文/暗号文を判別する。
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM 推奨 96bit
const KEY_BYTES = 32; // AES-256
const AUTH_TAG_BYTES = 16;

export interface EncryptedValue {
  /** base64(ciphertext || authTag)。 */
  value: string;
  /** base64(iv)。 */
  iv: string;
}

/** env の鍵文字列（base64 32B または hex 64 桁）を 32 バイト鍵へ復元する。長さ不一致は起動時失敗。 */
export function parseEncKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // hex 64 桁を優先判定（base64 と曖昧にならないよう厳密一致）。
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    key = Buffer.from(trimmed, 'base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `EXAPP_APIKEY_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); use base64(32B) or hex(64 chars)`,
    );
  }
  return key;
}

/** 平文を AES-256-GCM で暗号化する。 */
export function encryptApiKey(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    value: Buffer.concat([ciphertext, authTag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/** AES-256-GCM 暗号文を復号する。authTag 不一致（改ざん）は例外。 */
export function decryptApiKey(stored: EncryptedValue, key: Buffer): string {
  const iv = Buffer.from(stored.iv, 'base64');
  const blob = Buffer.from(stored.value, 'base64');
  if (blob.length < AUTH_TAG_BYTES) {
    throw new Error('stored apiKey ciphertext is too short to contain an auth tag');
  }
  const ciphertext = blob.subarray(0, blob.length - AUTH_TAG_BYTES);
  const authTag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  // authTagLength を明示して 16 バイト未満の短縮タグ受理を防ぐ（GCM タグ偽造対策）。
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

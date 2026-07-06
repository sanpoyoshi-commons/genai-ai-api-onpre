import { badRequest } from '../http/errors.js';
import type { ToBeRecordedMessage } from '../../types/genaiWeb.js';

/**
 * createMessages の extraData URL 検証（上流 `createMessages.ts` の isValidExtraData 移植・MIT）。
 *
 * 上流は S3 アップロード済みファイルの URL（open-redirect／path-traversal 対策）を検証する。
 * 本リポではローカルストレージ（SeaweedFS）の公開ホストへ読み替える seam とし、
 * `FILE_PUBLIC_HOST`（β で配線）未設定時は s3 参照を受理しない（ストレージ非依存の第1バッチ方針）。
 * base64／json タイプは URL ではないため検証対象外。
 */
const allowedHost = process.env.FILE_PUBLIC_HOST;

// look-alike スラッシュ（U+2044 FRACTION SLASH, U+2215 DIVISION SLASH, U+FF0F FULLWIDTH SOLIDUS）。
const LOOKALIKE_SLASHES = new Set(['⁄', '∕', '／', '\\']);
// %エンコード（二重含む）スラッシュ／バックスラッシュ。
const ENCODED_SLASH = /%25(?:2f|5c)|%(?:2f|5c)/i;

export function assertValidExtraData(messages: ToBeRecordedMessage[]): void {
  for (const message of messages) {
    for (const extra of message.extraData ?? []) {
      if (extra.source.type !== 's3') {
        continue;
      }
      if (!allowedHost) {
        throw badRequest('file storage is not configured for s3 references');
      }
      if (!isAllowedUrl(extra.source.data, allowedHost)) {
        throw badRequest('invalid extraData');
      }
    }
  }
}

function hasControlOrLookalike(data: string): boolean {
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || LOOKALIKE_SLASHES.has(ch)) {
      return true;
    }
  }
  return false;
}

function isAllowedUrl(data: string, host: string): boolean {
  if (hasControlOrLookalike(data) || ENCODED_SLASH.test(data)) {
    return false;
  }
  if (!URL.canParse(data)) {
    return false;
  }
  const parsed = new URL(data);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return false;
  }
  return parsed.hostname.toLowerCase().replace(/\.$/, '') === host;
}

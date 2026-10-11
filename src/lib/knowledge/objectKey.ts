import { randomUUID } from 'node:crypto';
import { authorizeOwnedKey } from '../storage/ownership.js';

/**
 * 原本（Bronze）のキーの組み立てと検査。
 *
 * 形は添付と同じ `${userId}/${uuid}/${filename}`（`../storage/ownership.ts` の `authorizeOwnedKey` と
 * 同じ規則＝先頭のセグメントが所有者）。ブラウザは署名付き URL へ直に上げ、そのキーを api へ渡してくるので、
 * **api は受け取ったキーを所有者とキーの形の両方で確かめてから読む**。
 */

/** キーに使えるファイル名の最大長（S3 のキー全体の上限 1024 バイトに対する余裕）。 */
const NAME_MAX = 120;

/**
 * ファイル名をキーに置ける形に直す。区切り（`/`・`\`）・制御文字・前後の空白と点を落とし、長さを切る。
 * 残らなければ `fallback` を使う（名前を失うより、無名で入れる方が利用者の手戻りが少ない）。
 */
export function safeObjectName(raw: string, fallback: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      continue;
    }
    out += ch === '/' || ch === '\\' ? '_' : ch;
  }
  out = out.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  if (out.length > NAME_MAX) {
    // 拡張子を残したまま前半を切る（拡張子は形式の判定に使うため）。
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : '';
    out = out.slice(0, NAME_MAX - ext.length) + ext;
  }
  return out.length > 0 ? out : fallback;
}

/** 新しい原本のキーを作る（所有者の sub が先頭・途中に uuid・末尾にファイル名）。 */
export function knowledgeObjectKey(ownerUserId: string, filename: string, fallback: string): string {
  return `${ownerUserId}/${randomUUID()}/${safeObjectName(filename, fallback)}`;
}

/**
 * ブラウザから渡されたキーを受け取ってよいか。
 *
 * 所有者（先頭のセグメント）が本人であることに加え、**キーの形**も見る。`.`／`..`／空のセグメントを
 * 含むキーは断る（オブジェクトストレージはキーを文字列として扱うが、経路の途中で正規化されると
 * 所有者のプレフィックスから外へ出られる余地が残るため、受け口で閉じておく）。
 */
export function isSafeOwnedKey(key: string, ownerUserId: string): boolean {
  if (!authorizeOwnedKey(key, ownerUserId)) {
    return false;
  }
  const segments = key.split('/');
  if (segments.length < 3) {
    return false;
  }
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/** キーの末尾のセグメント（元のファイル名）。 */
export function filenameOfKey(key: string): string {
  const segments = key.split('/');
  return segments[segments.length - 1] ?? '';
}

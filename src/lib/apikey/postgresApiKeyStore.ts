import { getPrisma } from '../db.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { ApiKeyStore } from './apiKeyStore.js';
import { decryptApiKey, encryptApiKey, parseEncKey } from './crypto.js';

/**
 * ApiKeyStore の実ストア（DeferredApiKeyStore の差し替え先）。
 *
 * 呼び出し用 apiKey を専用テーブル ex_app_api_keys（team+ex_app スコープ）へ保存する。GUI から per-app に
 * 動的増加するため docker secrets（静的ファイル）ではなくテーブルを採る（確定方針）。
 * EXAPP_APIKEY_ENC_KEY が設定されていればアプリ層 AES-256-GCM で暗号化、無ければ平文（localhost 単一運用の
 * 最小実装）。createExApp/updateExApp/copyExApp/deleteExApp/deleteTeam・worker（外部呼び出し時の getApiKey）が
 * 共有する。worker も同ストアで getApiKey して復号する（鍵は同一 env）。
 */
export class PostgresApiKeyStore implements ApiKeyStore {
  private readonly encKey: Buffer | null;

  constructor(
    private readonly prisma: PrismaClient = getPrisma(),
    encKeyRaw: string | undefined = process.env.EXAPP_APIKEY_ENC_KEY,
  ) {
    this.encKey = encKeyRaw && encKeyRaw.trim().length > 0 ? parseEncKey(encKeyRaw) : null;
  }

  async getApiKey(teamId: string, exAppId: string): Promise<string | null> {
    const row = await this.prisma.exAppApiKey.findUnique({
      where: { teamId_exAppId: { teamId, exAppId } },
      select: { value: true, encIv: true },
    });
    if (!row) {
      return null;
    }
    // enc_iv の有無で平文/暗号文を判別する。鍵未設定で暗号文に当たった場合は復号不能＝明示エラー。
    if (row.encIv === null) {
      return row.value;
    }
    if (!this.encKey) {
      throw new Error('stored apiKey is encrypted but EXAPP_APIKEY_ENC_KEY is not configured');
    }
    return decryptApiKey({ value: row.value, iv: row.encIv }, this.encKey);
  }

  async setApiKey(teamId: string, exAppId: string, value: string): Promise<void> {
    const { storedValue, encIv } = this.encKey
      ? (() => {
          const enc = encryptApiKey(value, this.encKey as Buffer);
          return { storedValue: enc.value, encIv: enc.iv };
        })()
      : { storedValue: value, encIv: null as string | null };
    await this.prisma.exAppApiKey.upsert({
      where: { teamId_exAppId: { teamId, exAppId } },
      create: { teamId, exAppId, value: storedValue, encIv },
      update: { value: storedValue, encIv },
    });
  }

  async deleteApiKey(teamId: string, exAppId: string): Promise<void> {
    // 不在は無操作・冪等（deleteMany）。
    await this.prisma.exAppApiKey.deleteMany({ where: { teamId, exAppId } });
  }
}

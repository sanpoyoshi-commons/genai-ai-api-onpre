import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { logger } from './logger.js';

const DB_COMPONENT = 'api.db';
const DEFAULT_SLOW_QUERY_MS = 500;

/**
 * ランタイム DB クライアント（PostgreSQL / Prisma 7 driver adapter）。
 *
 * Prisma 7 は schema から接続 URL を廃止したため、@prisma/adapter-pg に接続文字列を渡して
 * PrismaClient を構築する。import 時の副作用を避けるため lazy 初期化とし、DATABASE_URL が
 * 未設定のまま起動した場合は最初の利用時点で fail させる（無設定起動の早期検知）。
 *
 * query/error イベントをフックして component='api.db' で
 * db_query_succeeded（DEBUG・基本 silent）/ db_query_slow（WARN・しきい値超過）/
 * db_query_failed（ERROR）を構造化出力する。しきい値は DB_SLOW_QUERY_MS（既定 500ms）。
 */
let client: PrismaClient<'query' | 'warn' | 'error'> | undefined;

export function getPrisma(): PrismaClient<'query' | 'warn' | 'error'> {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    const slowMs = Number.parseInt(process.env.DB_SLOW_QUERY_MS ?? '', 10);
    const slowThresholdMs = Number.isFinite(slowMs) && slowMs > 0 ? slowMs : DEFAULT_SLOW_QUERY_MS;
    const log = logger.child({ component: DB_COMPONENT });

    const created = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    created.$on('query', (e) => {
      const duration_ms = e.duration;
      if (duration_ms >= slowThresholdMs) {
        log.warn(
          { event: 'db_query_slow', duration_ms, query: e.query },
          'slow db query',
        );
      } else {
        log.debug(
          { event: 'db_query_succeeded', duration_ms, query: e.query },
          'db query succeeded',
        );
      }
    });
    created.$on('error', (e) => {
      log.error(
        { event: 'db_query_failed', error: { message: e.message } },
        'db query failed',
      );
    });
    created.$on('warn', (e) => {
      log.warn(
        { event: 'db_warning', error: { message: e.message } },
        'db warning',
      );
    });

    client = created;
  }
  return client;
}

/** テスト等でクライアントを切断する。 */
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

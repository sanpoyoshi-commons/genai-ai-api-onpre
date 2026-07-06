import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 設定。接続 URL は schema から廃止されたため migrate / introspect 用 URL を
 * ここで env から渡す（ランタイムの PrismaClient は @prisma/adapter-pg 経由＝src/lib/db.ts）。
 * DATABASE_URL は実行環境（deploy compose / Docker -e）から供給する。
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

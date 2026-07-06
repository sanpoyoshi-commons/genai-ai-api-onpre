/**
 * TTL 期限の算出（上流 `repository/client.ts` の TTL_DAYS=364 既定に対応）。
 *
 * 上流は epoch 秒で expire_at を持つが、本リポは TIMESTAMPTZ（Date）で保持する（schema.prisma）。
 * 実際の自動削除は pg_cron が担う。本関数は挿入時に期限値を埋めるだけ。
 */
const TTL_DAYS = Number(process.env.TTL_DAYS ?? '364');

export function ttlExpireAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * 受信回数に応じた可視性タイムアウト（秒）の段階的バックオフ。
 * 設計ノート（ExApp 非同期実行の疑似ロングポーリング仕様）由来の閾値：
 * 受信 240 / 480 / 720 回超で 60 / 300 / 900 秒へ延長。未満は既定 30 秒。
 * 閾値は設計ノートに記録された仕様値。
 */
export const DEFAULT_VISIBILITY_SECONDS = 30;

export function backoffVisibilitySeconds(receiveCount: number): number {
  if (receiveCount > 720) return 900;
  if (receiveCount > 480) return 300;
  if (receiveCount > 240) return 60;
  return DEFAULT_VISIBILITY_SECONDS;
}

/**
 * 呼び出し用シークレット（apiKey）格納の seam（seam 注入＋実装は後続）。
 *
 * 上流は Secrets Manager（getApiKeyValue／setApiKey／deleteApiKey、APP_ENV スコープ）に apiKey を保持し、
 * アプリ登録レコードには持たせない（repository は応答で常に空文字を返す）。ローカルは
 * docker secrets 方針に対応するが、実装は後続のため、ここではインターフェースのみ定義して deps 注入する。
 * createExApp/updateExApp/copyExApp/deleteExApp/deleteTeam がこの seam を上流同等に呼ぶ（レコード書込と
 * apiKey 書込は別系統 2 段・上流踏襲＝補償なし）。unit テストは fake を注入する。
 */
export interface ApiKeyStore {
  /** チーム＋アプリスコープの apiKey を取得。不在は null（copyExApp が複製元から読む）。 */
  getApiKey(teamId: string, exAppId: string): Promise<string | null>;
  /** apiKey を保存（作成・更新）。 */
  setApiKey(teamId: string, exAppId: string, value: string): Promise<void>;
  /** apiKey を削除（不在は無操作・冪等）。 */
  deleteApiKey(teamId: string, exAppId: string): Promise<void>;
}

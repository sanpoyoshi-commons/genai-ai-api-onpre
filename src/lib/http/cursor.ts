/**
 * ページネーションカーソル（上流の不透明 lastEvaluatedKey に対応）。PK を base64 で包んだ不透明トークン。
 * teams／teamUsers／exApps の列挙系で共有する（chats は自前の同等実装を持つ）。
 */
export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function decodeCursor(token?: string): string | undefined {
  return token ? Buffer.from(token, 'base64').toString('utf8') : undefined;
}

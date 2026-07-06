import { readFileSync } from 'node:fs';

/**
 * 機微値を env から読む（docker secrets ハードニング）。
 *
 * `${name}_FILE` が設定されていればそのファイル内容（trim）を優先し、無ければ `env[name]` を返す。
 * docker secrets（`/run/secrets/x` を `${name}_FILE` で指す）と素の env の両対応＝自前イメージ（api/worker）
 * での `_FILE` 規約サポート（原則：3rd-party イメージのみ entrypoint ラッパ、自前はアプリ対応）。
 * 値が空または未設定なら undefined。`_FILE` 指定があるのに読めない場合は素の env へフォールバックせず例外を
 * 伝播させる（設定ミスを黙って握りつぶさない）。
 */
export function readSecretEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const filePath = env[`${name}_FILE`]?.trim();
  if (filePath) {
    const content = readFileSync(filePath, 'utf8').trim();
    return content || undefined;
  }
  const value = env[name]?.trim();
  return value || undefined;
}

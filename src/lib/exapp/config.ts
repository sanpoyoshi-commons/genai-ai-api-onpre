/**
 * ExApp 外部呼び出しの実行設定（env 由来）。api（endpoint 検証）と worker（実行）で共有する。
 *
 * - EXAPP_ALLOW_PRIVATE_ENDPOINTS：localhost/プライベート宛を許可するか（既定 false＝安全側）。
 * - EXAPP_ENDPOINT_ALLOWLIST：許可する宛先（host または IPv4 CIDR、カンマ区切り）。private 許可時のゲート。
 * - EXAPP_HTTP_TIMEOUT_MS：外部 HTTP の timeout（既定 30000）。
 * - EXAPP_ARTIFACT_THRESHOLD_BYTES：outputs テキストをストレージ退避する閾値（既定 10240＝10KB）。
 */
export interface ExAppExecConfig {
  allowPrivateEndpoints: boolean;
  endpointAllowlist: string[];
  httpTimeoutMs: number;
  artifactThresholdBytes: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ARTIFACT_THRESHOLD_BYTES = 10_240;

function parseList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadExAppExecConfig(env: NodeJS.ProcessEnv = process.env): ExAppExecConfig {
  return {
    allowPrivateEndpoints: env.EXAPP_ALLOW_PRIVATE_ENDPOINTS === 'true',
    endpointAllowlist: parseList(env.EXAPP_ENDPOINT_ALLOWLIST),
    httpTimeoutMs: parsePositiveInt(env.EXAPP_HTTP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    artifactThresholdBytes: parsePositiveInt(env.EXAPP_ARTIFACT_THRESHOLD_BYTES, DEFAULT_ARTIFACT_THRESHOLD_BYTES),
  };
}

/**
 * ExApp endpoint の SSRF ガード。
 *
 * 既定は安全側：localhost / プライベート / リンクローカル / 単一ラベル内部ホスト宛を拒否する。ローカル運用では
 * EXAPP_ALLOW_PRIVATE_ENDPOINTS=true かつ EXAPP_ENDPOINT_ALLOWLIST に明示列挙した宛先のみ許可する
 * （確定方針）。worker の初回 POST／status_url polling の双方で、外部へ出る直前に検証する。
 *
 * 限界（明文化）：DNS 名は解決しない（DNS rebinding は対象外）。localhost 限定運用＝
 * 02_アーキテクチャ-ローカル版 の 127.0.0.1/192.168 制限前提での最小防御。公開運用では https 公開宛のみとする。
 */

export interface EndpointPolicy {
  allowPrivateEndpoints: boolean;
  /** host（完全一致・大小無視）または IPv4 CIDR。 */
  allowlist: string[];
}

/** SSRF ガードで拒否された宛先（worker はこれを error 完了に写像する）。 */
export class EndpointNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointNotAllowedError';
  }
}

type Ipv4 = [number, number, number, number];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(host: string): Ipv4 | null {
  const m = IPV4_RE.exec(host);
  if (!m) {
    return null;
  }
  const octets: Ipv4 = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function ipv4ToInt(octets: Ipv4): number {
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function isPrivateIpv4(octets: Ipv4): boolean {
  const [a, b] = octets;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/** host が localhost/プライベート/単一ラベル内部ホストか（＝既定で拒否すべき宛先か）。 */
export function isLocalOrPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // IPv6 ブラケット除去
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'host.docker.internal') return true;
  // IPv6 ループバック/ユニークローカル(fc00::/7)/リンクローカル(fe80::/10)。
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  const octets = parseIpv4(h);
  if (octets) {
    return isPrivateIpv4(octets);
  }
  // ドットを含まない単一ラベル＝Docker 内部コンテナ名等の内部ホストとみなす。
  if (!h.includes('.')) return true;
  return false;
}

/** allowlist エントリ（host 完全一致 or IPv4 CIDR）に host が一致するか。 */
function matchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const hostOctets = parseIpv4(h);
  for (const rawEntry of allowlist) {
    const entry = rawEntry.toLowerCase();
    if (entry.includes('/')) {
      // IPv4 CIDR。host が IPv4 のときのみ照合。
      const [net, bitsRaw] = entry.split('/');
      const netOctets = net ? parseIpv4(net) : null;
      const bits = Number(bitsRaw);
      if (!hostOctets || !netOctets || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        continue;
      }
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((ipv4ToInt(hostOctets) & mask) === (ipv4ToInt(netOctets) & mask)) {
        return true;
      }
    } else if (entry === h) {
      return true;
    }
  }
  return false;
}

/**
 * endpoint/status_url を検証し、許可された URL を返す。protocol は http/https のみ。
 * public 宛は常に許可（既定の安全側）。private/local 宛は allowPrivateEndpoints かつ allowlist 一致時のみ許可。
 * 不正 URL・スキーム不可・未許可宛は EndpointNotAllowedError。
 */
export function assertAllowedEndpoint(rawUrl: string, policy: EndpointPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EndpointNotAllowedError(`invalid endpoint URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EndpointNotAllowedError(`endpoint protocol not allowed: ${url.protocol}`);
  }
  if (!isLocalOrPrivateHost(url.hostname)) {
    return url; // public 宛は許可。
  }
  if (!policy.allowPrivateEndpoints) {
    throw new EndpointNotAllowedError(
      `private/local endpoint is blocked: ${url.hostname} (set EXAPP_ALLOW_PRIVATE_ENDPOINTS=true to allow)`,
    );
  }
  if (!matchesAllowlist(url.hostname, policy.allowlist)) {
    throw new EndpointNotAllowedError(
      `private/local endpoint not in EXAPP_ENDPOINT_ALLOWLIST: ${url.hostname}`,
    );
  }
  return url;
}

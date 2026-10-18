import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_V4: Array<{ base: number; mask: number }> = [];
function v4(s: string): number | null {
  const p = s.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}
function cidr(c: string): void {
  const [ip, bits] = c.split('/');
  const b = v4(ip);
  if (b === null) return;
  const m = Number(bits);
  const mask = m === 0 ? 0 : (0xffffffff - (2 ** (32 - m) - 1)) >>> 0;
  BLOCKED_V4.push({ base: (b & mask) >>> 0, mask });
}
['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '0.0.0.0/8', '100.64.0.0/10', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '192.88.99.0/24'].forEach(cidr);
const METADATA_IPS = new Set(['169.254.169.254', 'fd00:ec2::254', '100.100.100.200']);

export function isBlockedIp(ip: string): boolean {
  const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_IPS.has(low)) return true;
  if (low === 'localhost' || low === '::1' || low === '::ffff:127.0.0.1') return true;
  if (low.includes(':')) {
    if (low === '::' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('ff')) return true;
    if (low.startsWith('::ffff:')) {
      const v = v4(low.slice('::ffff:'.length));
      if (v !== null) return isBlockedV4(v);
    }
    return false;
  }
  const v = v4(low);
  return v === null ? true : isBlockedV4(v);
}
function isBlockedV4(v: number): boolean {
  const u = v >>> 0;
  return BLOCKED_V4.some(({ base, mask }) => ((u & mask) >>> 0) === base);
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function rejectFast(urlStr: string, allowlist: string[] = []): string | null {
  const t = urlStr.trim();
  if (/^(file|data|ftp|gopher|dict|ldap|jar|vbscript|javascript):/i.test(t)) return 'BLOCKED_URL: only http/https URLs allowed';
  if (!isHttpUrl(t)) return 'BLOCKED_URL: only http/https URLs allowed';
  let u: URL;
  try { u = new URL(t); } catch { return 'BLOCKED_URL: invalid URL'; }
  if (u.username || u.password) return 'BLOCKED_URL: URLs with credentials are not allowed';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    if (!allowlist.some((a) => host === a.toLowerCase())) return 'BLOCKED_URL: internal host is not allowed';
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    if (!allowlist.some((a) => host === a.toLowerCase())) return 'BLOCKED_URL: private/link-local address is not allowed';
  }
  return null;
}

export type DnsLookup = (host: string, opts?: unknown) => Promise<unknown>;
export async function resolveBlocked(host: string, dnsFn: DnsLookup = dns.lookup as unknown as DnsLookup): Promise<string | null> {
  try {
    const all = await dnsFn(host, { all: true });
    const list = Array.isArray(all) ? all : [all];
    for (const r of list) {
      const addr = (r as { address?: string }).address ?? String(r);
      if (isBlockedIp(addr)) return `BLOCKED_URL: ${host} resolves to a private/link-local address`;
    }
    return null;
  } catch {
    return null;
  }
}

const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', '_hsenc', '_hsmi', 'yclid', 'dclid', 'srsltid']);

export function stripTrackingParams(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return urlStr; }
}

export function domainOf(urlStr: string): string {
  try { return new URL(urlStr).hostname; } catch { return urlStr; }
}

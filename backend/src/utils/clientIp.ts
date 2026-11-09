/**
 * The client IP we are willing to believe.
 *
 * Behind the Cloudflare Tunnel the chain is: browser → Cloudflare edge →
 * `cloudflared` running on loopback → Caddy → Fastify. Cloudflare stamps the real
 * client address into `CF-Connecting-IP` and cloudflared forwards it, so the
 * immediate peer of this process is always the local tunnel (127.0.0.1 / ::1).
 *
 * That header is therefore trusted **only** when the immediate peer is one of
 * `TRUST_PROXY_ADDRESSES` (loopback by default). A request arriving from anywhere
 * else keeps its own address as the rate-limit and lockout key even if it sets the
 * header, because otherwise one forged header would let anyone choose somebody
 * else's bucket — including locking the real admin out by pretending to be them.
 *
 * `X-Forwarded-For` is deliberately not read here: Fastify already handles it when
 * `trustProxy` is a loopback predicate, and adding a second, differently-parsed
 * source of truth is how these bugs happen.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-f:.]+$/i;

/** IPv4 with every octet in range, IPv6 as a loose but bounded literal. */
export function isIpLiteral(value: string): boolean {
  const v4 = IPV4.exec(value);
  if (v4) return v4.slice(1).every((octet) => Number(octet) <= 255);
  if (!IPV6.test(value)) return false;
  if (!value.includes(':')) return false;
  // Reject things that are not an address shape: leading/trailing colons beyond
  // "::", more than one "::", a segment longer than four hex digits.
  if ((value.match(/::/g) ?? []).length > 1) return false;
  if (value.includes(':::')) return false;
  return value.split(':').every((segment) => segment.length <= 4);
}

/** `::ffff:127.0.0.1` and `127.0.0.1` are the same peer; drop the mapped prefix. */
export function normalisePeer(address: string | undefined | null): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (trimmed === '') return null;
  // Strip a zone id (fe80::1%eth0) and the IPv4-mapped IPv6 prefix.
  const withoutZone = trimmed.split('%')[0] ?? trimmed;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(withoutZone);
  return (mapped?.[1] ?? withoutZone).toLowerCase();
}

export function isLoopback(address: string | null): boolean {
  if (!address) return false;
  return address === '::1' || address === '0:0:0:0:0:0:0:1' || address.startsWith('127.');
}

export interface ClientIpInput {
  /** `request.socket.remoteAddress` — who actually opened the TCP connection. */
  peer?: string | null;
  /** `CF-Connecting-IP`, only meaningful when the peer is the local tunnel. */
  cfConnectingIp?: string | string[] | null;
  trustedAddresses: readonly string[];
  fallback?: string;
}

export function resolveClientIp({ peer, cfConnectingIp, trustedAddresses, fallback = 'unknown' }: ClientIpInput): string {
  const remote = normalisePeer(peer);
  const header = singleHeaderValue(cfConnectingIp);

  if (remote === null) return header ?? fallback;

  const trusted = trustedAddresses.some((entry) => normalisePeer(entry) === remote);
  if (!trusted) return remote;

  if (header !== null && isIpLiteral(header)) return header.toLowerCase();
  return remote;
}

function singleHeaderValue(value: string | string[] | null | undefined): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // A comma means a list; we refuse to guess which entry is the client.
    return trimmed === '' || trimmed.includes(',') ? null : trimmed;
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    const trimmed = value[0].trim();
    return trimmed === '' || trimmed.includes(',') ? null : trimmed;
  }
  return null;
}

import { describe, expect, it } from 'vitest';
import { isIpLiteral, normalisePeer, resolveClientIp } from '../src/utils/clientIp.js';

/**
 * Who is allowed to say who the client is.
 *
 * Behind the Cloudflare Tunnel every request arrives from the local cloudflared,
 * so the only way to rate-limit or lock out the real client is to believe
 * `CF-Connecting-IP` — and the only safe condition for believing it is a loopback
 * peer. These tests exist because getting it backwards means one forged header
 * lets an attacker choose somebody else's rate-limit bucket, including the
 * admin's, and lock the real user out for free.
 */

const LOOPBACK = ['127.0.0.1', '::1'];

describe('resolveClientIp', () => {
  it('believes CF-Connecting-IP when the peer is the local tunnel', () => {
    expect(
      resolveClientIp({ peer: '127.0.0.1', cfConnectingIp: '203.0.113.7', trustedAddresses: LOOPBACK }),
    ).toBe('203.0.113.7');
  });

  it('believes it over the IPv6 loopback too', () => {
    expect(resolveClientIp({ peer: '::1', cfConnectingIp: '2001:db8::1', trustedAddresses: LOOPBACK })).toBe(
      '2001:db8::1',
    );
  });

  it('ignores a spoofed header from any other source', () => {
    // Someone on the network, or a proxy we do not control, claims to be 1.2.3.4.
    expect(
      resolveClientIp({ peer: '203.0.113.9', cfConnectingIp: '1.2.3.4', trustedAddresses: LOOPBACK }),
    ).toBe('203.0.113.9');
  });

  it('ignores a spoofed header from a private but untrusted address', () => {
    expect(
      resolveClientIp({ peer: '10.1.2.3', cfConnectingIp: '127.0.0.1', trustedAddresses: LOOPBACK }),
    ).toBe('10.1.2.3');
  });

  it('treats 127.0.0.1 and ::ffff:127.0.0.1 as the same trusted peer', () => {
    expect(
      resolveClientIp({ peer: '::ffff:127.0.0.1', cfConnectingIp: '198.51.100.4', trustedAddresses: LOOPBACK }),
    ).toBe('198.51.100.4');
  });

  it('refuses a header carrying a list instead of one address', () => {
    // "1.2.3.4, 5.6.7.8" is either a proxy chain or an attempt to smuggle a value.
    expect(
      resolveClientIp({ peer: '127.0.0.1', cfConnectingIp: '1.2.3.4, 5.6.7.8', trustedAddresses: LOOPBACK }),
    ).toBe('127.0.0.1');
  });

  it('refuses a header that is not an IP literal', () => {
    for (const bogus of ['not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4:80', 'file:///etc/passwd', '']) {
      expect(resolveClientIp({ peer: '127.0.0.1', cfConnectingIp: bogus, trustedAddresses: LOOPBACK })).toBe(
        '127.0.0.1',
      );
    }
  });

  it('falls back to the peer when there is no header at all', () => {
    expect(resolveClientIp({ peer: '127.0.0.1', trustedAddresses: LOOPBACK })).toBe('127.0.0.1');
    expect(resolveClientIp({ peer: '203.0.113.9', trustedAddresses: LOOPBACK })).toBe('203.0.113.9');
  });

  it('only trusts the addresses it was given', () => {
    expect(
      resolveClientIp({ peer: '192.168.1.5', cfConnectingIp: '203.0.113.7', trustedAddresses: ['192.168.1.5'] }),
    ).toBe('203.0.113.7');
    expect(
      resolveClientIp({ peer: '127.0.0.1', cfConnectingIp: '203.0.113.7', trustedAddresses: ['192.168.1.5'] }),
    ).toBe('127.0.0.1');
  });
});

describe('isIpLiteral', () => {
  it('accepts real addresses', () => {
    for (const value of ['127.0.0.1', '0.0.0.0', '255.255.255.255', '::1', '2001:db8::ff00:42:8329']) {
      expect(isIpLiteral(value)).toBe(true);
    }
  });

  it('rejects anything that is not a bare address', () => {
    for (const value of ['256.1.1.1', '1.2.3', '1.2.3.4.', 'gs://bucket', ':::', 'localhost', '1.2.3.4:8080']) {
      expect(isIpLiteral(value)).toBe(false);
    }
  });
});

describe('normalisePeer', () => {
  it('strips IPv4-mapped prefixes, zone ids and case', () => {
    expect(normalisePeer('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalisePeer('FE80::1%lo0')).toBe('fe80::1');
    expect(normalisePeer('::1')).toBe('::1');
    expect(normalisePeer('')).toBeNull();
    expect(normalisePeer(undefined)).toBeNull();
  });
});

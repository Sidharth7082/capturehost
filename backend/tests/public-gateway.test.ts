import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type AuthedApp } from './appHarness.js';

/**
 * Public exposure, end to end as far as it can be tested without a tunnel.
 *
 * Two halves:
 *  1. the Caddyfile contract — the gateway is one path and everything else on
 *     that listener is a 404, and the apps listener proxies nothing at all;
 *  2. the client-IP contract — the real address is taken from CF-Connecting-IP
 *     for a loopback peer and ignored for anybody else, so rate limits and
 *     lockouts key on the actual client.
 */

const CADDYFILE = readFileSync(resolve(import.meta.dirname, '../../deploy/caddy/Caddyfile'), 'utf8');

/** Returns the text of one site block, from its address line to its closing brace. */
function siteBlock(address: string): string | null {
  const lines = CADDYFILE.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(address) && line.trim().endsWith('{'));
  if (start === -1) return null;

  let depth = 0;
  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    block.push(line);
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (depth === 0 && block.length > 1) break;
  }
  return block.join('\n');
}

describe('Caddyfile — webhook gateway', () => {
  const gateway = siteBlock('http://hooks.captureordie.online:8081');

  it('exists, on its own loopback listener', () => {
    expect(gateway, 'gateway site block missing').not.toBeNull();
    expect(gateway).toMatch(/bind 127\.0\.0\.1/);
  });

  it('forwards only POST /api/webhooks/github/<digits>', () => {
    expect(gateway).toMatch(/method POST/);
    expect(gateway).toMatch(/path_regexp\s+\w+\s+\^\/api\/webhooks\/github\/\[0-9\]\{1,20\}\$/);
  });

  it('caps the body at 1 MB before buffering', () => {
    expect(gateway).toMatch(/request_body\s*\{[^}]*max_size 1MB/s);
  });

  it('proxies to the backend and nothing else', () => {
    const dials = [...(gateway ?? '').matchAll(/reverse_proxy\s+([^\s{]+)/g)].map((m) => m[1]);
    expect(dials).toEqual(['127.0.0.1:8787']);
  });

  it('answers 404 for every other request on the gateway host', () => {
    expect(gateway).toMatch(/handle\s*\{\s*respond 404\s*\}/s);
  });

  it('answers 404 for other hostnames on the gateway port', () => {
    const fallback = siteBlock('http://:8081');
    expect(fallback).not.toBeNull();
    expect(fallback).toMatch(/bind 127\.0\.0\.1/);
    expect(fallback).toMatch(/respond 404/);
  });
});

describe('Caddyfile — apps listener proxies nothing of ours', () => {
  const apps = siteBlock('http://:8080');

  it('is a bare loopback listener', () => {
    expect(apps).not.toBeNull();
    expect(apps).toMatch(/bind 127\.0\.0\.1/);
  });

  it('contains no reverse_proxy at all', () => {
    // Routes come from the backend's reconciler, tagged and re-applied from
    // SQLite. A proxy written here would either shadow every deployed site or
    // publish the dashboard on the port a tunnel exposes.
    expect(apps).not.toMatch(/reverse_proxy/);
  });

  it('never mentions the private ports', () => {
    for (const port of ['8090', '8787', '5173', '2019', '2375']) {
      expect(apps, `apps listener references ${port}`).not.toContain(port);
    }
  });
});

describe('client IP behind the tunnel', () => {
  let harness: AuthedApp;

  beforeEach(async () => {
    harness = await startApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  const lastLoginIp = (): string | null => {
    const row = harness.db
      .prepare("SELECT ip FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1")
      .get() as { ip: string | null } | undefined;
    return row?.ip ?? null;
  };

  const attemptLogin = async (remoteAddress: string, cfConnectingIp: string): Promise<void> => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody-in-particular', password: 'not-the-password' },
      remoteAddress,
      headers: { 'cf-connecting-ip': cfConnectingIp },
    });
  };

  it('believes CF-Connecting-IP when the request comes from the local tunnel', async () => {
    await attemptLogin('127.0.0.1', '203.0.113.7');
    expect(lastLoginIp()).toBe('203.0.113.7');
  });

  it('ignores a spoofed CF-Connecting-IP from another source', async () => {
    // The peer is not loopback, so the header is hostile input. Keying the
    // lockout on 1.2.3.4 would let this caller burn somebody else's bucket.
    await attemptLogin('203.0.113.9', '1.2.3.4');
    expect(lastLoginIp()).toBe('203.0.113.9');
  });

  it('ignores a spoofed header naming the admin loopback address', async () => {
    await attemptLogin('198.51.100.20', '127.0.0.1');
    expect(lastLoginIp()).toBe('198.51.100.20');
  });
});

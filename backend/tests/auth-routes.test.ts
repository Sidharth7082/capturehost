import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type AuthedApp } from './appHarness.js';

/**
 * The security contract of Phase 2, exercised over real HTTP and real
 * WebSockets: nothing works without a session, writes need CSRF, sockets need
 * both a session and an allowed Origin.
 */

let harness: AuthedApp;

beforeEach(async () => {
  harness = await startApp();
});

afterEach(async () => {
  await harness.close();
});

/** Every authenticated route. New endpoints must be added here. */
const PROTECTED_ROUTES: ReadonlyArray<[string, string]> = [
  ['GET', '/api/metrics/history'],
  ['GET', '/api/audit'],
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/auth/change-password'],
  ['GET', '/api/auth/sessions'],
  ['DELETE', '/api/auth/sessions/abcdef1234567890'],
  ['POST', '/api/auth/sessions/revoke-others'],
  ['POST', '/api/auth/2fa/setup'],
  ['POST', '/api/auth/2fa/confirm'],
  ['POST', '/api/auth/2fa/disable'],
  ['GET', '/api/docker/status'],
  ['GET', '/api/docker/containers'],
  ['GET', '/api/docker/containers/abcdef1234567890'],
  ['POST', '/api/docker/containers/abcdef1234567890/start'],
  ['POST', '/api/docker/containers/abcdef1234567890/stop'],
  ['POST', '/api/docker/containers/abcdef1234567890/restart'],
  ['DELETE', '/api/docker/containers/abcdef1234567890'],
  // Phase 4
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['GET', '/api/projects/1'],
  ['PATCH', '/api/projects/1'],
  ['DELETE', '/api/projects/1?confirm=demo'],
  ['POST', '/api/projects/1/deploy'],
  ['GET', '/api/projects/1/deployments'],
  ['POST', '/api/projects/1/deployments/2/cancel'],
  ['POST', '/api/projects/1/rollback'],
  ['GET', '/api/projects/1/env'],
  ['PUT', '/api/projects/1/env'],
  ['DELETE', '/api/projects/1/env/API_KEY'],
  ['GET', '/api/projects/1/webhook'],
  ['GET', '/api/project-ports'],
  // Phase 5
  ['GET', '/api/domains'],
  ['POST', '/api/domains'],
  ['PATCH', '/api/domains/1'],
  ['DELETE', '/api/domains/1'],
  ['POST', '/api/domains/1/check'],
  ['GET', '/api/projects/1/domains'],
  ['GET', '/api/caddy/status'],
  // Phase 6
  ['GET', '/api/backups'],
  ['POST', '/api/backups'],
  ['DELETE', '/api/backups/1'],
  ['POST', '/api/backups/1/download'],
  ['GET', '/api/notifications'],
  ['POST', '/api/notifications/read'],
  ['GET', '/api/notifications/channel'],
  ['POST', '/api/notifications/test'],
  ['GET', '/api/doctor'],
];

describe('authentication gate', () => {
  it('allows GET /api/health without a session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('exposes setup-status so the login page can explain a fresh install', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/auth/setup-status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ setupComplete: true });
  });

  it('returns 401 for every protected route without a session', async () => {
    // Looping the list means a new route cannot quietly ship unprotected.
    for (const [method, url] of PROTECTED_ROUTES) {
      const response = await harness.app.inject({ method: method as 'GET', url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json().code, `${method} ${url}`).toBe('unauthenticated');
    }
  });

  it('rejects a forged session cookie', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'capturehost_sid=not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 200 for a protected route once logged in', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/metrics/history?range=1h',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('points');
  });

  it('sets an httpOnly, SameSite=Strict cookie', async () => {
    const { response } = await harness.login();
    const header = response.headers['set-cookie'];
    const raw = Array.isArray(header) ? header.join(';') : String(header);

    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
  });

  it('fails login with a generic message', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-password-123' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid username or password', code: 'unauthorized' });
  });

  it('validates the login body with zod', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });
});

describe('csrf', () => {
  it('rejects a write without the header', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  it('rejects a write with the wrong token', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { cookie, 'x-csrf-token': 'wrong-token-value' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts a write with the session-bound token', async () => {
    const { cookie, csrfToken } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects a write from a foreign Origin even with a valid CSRF token', async () => {
    const { cookie, csrfToken } = await harness.login();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { cookie, 'x-csrf-token': csrfToken, origin: 'https://evil.example.com' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('does not require CSRF for GET', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });
});

describe('proxy trust', () => {
  it('ignores X-Forwarded-For from an untrusted address (spoofed lockout key)', async () => {
    // maxFailures is 3 in the test config; the 3rd failure locks the key.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'definitely-not-it-1' },
        remoteAddress: '203.0.113.7',
        headers: { 'x-forwarded-for': '9.9.9.9' },
      });
    }

    const keys = harness.db
      .prepare("SELECT key FROM login_attempts WHERE kind = 'ip'")
      .all() as { key: string }[];

    expect(keys.map((row) => row.key)).toContain('203.0.113.7');
    // The spoofed address must not have created its own counter.
    expect(keys.map((row) => row.key)).not.toContain('9.9.9.9');
  });
});

describe('logout and sessions', () => {
  it('logout deletes the session server side', async () => {
    const { cookie, csrfToken } = await harness.login();

    const logout = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(logout.statusCode).toBe(200);

    const after = await harness.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('lists active sessions and revokes one', async () => {
    const first = await harness.login();
    const second = await harness.login();

    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: first.cookie },
    });
    const sessions = list.json().sessions as { id: string; current: boolean }[];
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);

    const other = sessions.find((session) => !session.current);
    const revoke = await harness.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other?.id}`,
      headers: { cookie: first.cookie, 'x-csrf-token': first.csrfToken },
    });
    expect(revoke.statusCode).toBe(200);

    const after = await harness.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('writes an audit entry for login and logout', async () => {
    const { cookie, csrfToken } = await harness.login();
    await harness.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const actions = (
      harness.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]
    ).map((row) => row.action);

    expect(actions).toContain('auth.login');
    expect(actions).toContain('auth.logout');
  });

  it('paginates the audit log', async () => {
    const { cookie } = await harness.login();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/audit?limit=1&offset=0',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: unknown[]; total: number; hasMore: boolean; limit: number };
    expect(body.limit).toBe(1);
    expect(body.entries.length).toBeLessThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('rate limiting over HTTP', () => {
  it('answers 429 with Retry-After and no detail about which limit hit', async () => {
    const attempts = 4;
    let last = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });

    for (let index = 0; index < attempts; index += 1) {
      last = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong-password-123' },
      });
    }

    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
    expect(last.json().error).toBe('Too many attempts. Try again later.');
  });
});

describe('websocket authentication', () => {
  const url = (): string => `ws://127.0.0.1:${harness.port}/ws/metrics`;

  function closeCode(options: WebSocket.ClientOptions): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url(), options);
      socket.on('close', (code: number) => resolve(code));
      socket.on('error', () => undefined);
      setTimeout(() => reject(new Error('server did not close the socket')), 4000);
    });
  }

  it('rejects a socket with no session', async () => {
    const code = await closeCode({ origin: 'http://localhost:5173' });
    expect(code).toBe(1008);
  });

  it('rejects a socket with a valid session but a foreign Origin', async () => {
    const { cookie } = await harness.login();
    const code = await closeCode({ origin: 'https://evil.example.com', headers: { Cookie: cookie } });
    expect(code).toBe(1008);
  });

  it('accepts a socket with a session and an allowed Origin', async () => {
    const { cookie } = await harness.login();

    const frames = await new Promise<string[]>((resolve, reject) => {
      const socket = new WebSocket(url(), { origin: 'http://localhost:5173', headers: { Cookie: cookie } });
      const received: string[] = [];

      socket.on('message', (data: WebSocket.RawData) => {
        received.push(String(data));
        if (received.length >= 2) {
          socket.close();
          resolve(received);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error(`only ${received.length} frames`)), 8000);
    });

    expect((JSON.parse(frames[0] ?? '{}') as { type: string }).type).toBe('hello');
    expect((JSON.parse(frames[1] ?? '{}') as { type: string }).type).toBe('snapshot');
  });

  it('closes the open socket when the session logs out', async () => {
    const { cookie, csrfToken } = await harness.login();

    const socket = new WebSocket(url(), { origin: 'http://localhost:5173', headers: { Cookie: cookie } });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const closed = new Promise<number>((resolve) => socket.on('close', (code: number) => resolve(code)));

    await harness.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    await expect(closed).resolves.toBe(1008);
  });
});

describe('security headers', () => {
  it('sets a strict CSP and no-sniff on API responses', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not allow CORS credentials for an unknown origin', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

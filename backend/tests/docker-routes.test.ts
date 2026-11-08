import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type AuthedApp } from './appHarness.js';

/**
 * Docker routes over real HTTP and real WebSockets, with a fake dockerode
 * client. Verifies the same things a browser would hit: auth, CSRF, the
 * protected-container rule, the audit trail and both sockets.
 */

const PROXY_ID = 'a'.repeat(64);
const WEB_ID = 'b'.repeat(64);
const DB_ID = 'c'.repeat(64);

let harness: AuthedApp;
let cookie: string;
let csrfToken: string;

beforeEach(async () => {
  harness = await startApp();
  ({ cookie, csrfToken } = await harness.login());
});

afterEach(async () => {
  await harness.close();
});

function authed(url: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', withCsrf = false) {
  return harness.app.inject({
    method,
    url,
    headers: { cookie, ...(withCsrf ? { 'x-csrf-token': csrfToken } : {}) },
  });
}

describe('GET /api/docker/status', () => {
  it('reports the engine version through the proxy', async () => {
    const response = await authed('/api/docker/status');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: true,
      version: '29.9.2',
      apiVersion: '1.56',
      containersRunning: 2,
      containersTotal: 3,
      hostUrl: 'http://127.0.0.1:2375',
    });
  });

  it('stays available:false when the proxy is down, with a 200', async () => {
    harness.docker.setAvailable(false);
    const response = await authed('/api/docker/status');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: false, error: 'Docker proxy unreachable' });
  });
});

describe('GET /api/docker/containers', () => {
  it('returns names, states and stats for running containers', async () => {
    const response = await authed('/api/docker/containers');
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      available: boolean;
      containers: { name: string; state: string; protected: boolean; stats: { cpuPct: number } | null }[];
    };

    expect(body.available).toBe(true);
    expect(body.containers.map((c) => `${c.name}:${c.state}`)).toEqual([
      'capturehost-socket-proxy:running',
      'web:running',
      'db:exited',
    ]);

    const web = body.containers.find((c) => c.name === 'web');
    expect(web?.stats?.cpuPct).toBe(50);
    // Stats are only fetched for running containers.
    expect(body.containers.find((c) => c.name === 'db')?.stats).toBeNull();
  });

  it('returns 503 when the proxy is unreachable', async () => {
    harness.docker.setAvailable(false);
    const response = await authed('/api/docker/containers');

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'docker_unavailable', error: 'Docker unavailable' });
  });
});

describe('GET /api/docker/containers/:id', () => {
  it('returns filtered inspect data', async () => {
    const response = await authed(`/api/docker/containers/${WEB_ID}`);
    expect(response.statusCode).toBe(200);

    const body = response.json() as { config: { envKeys: string[] }; name: string };
    expect(body.name).toBe('web');
    expect(body.config.envKeys).toContain('PATH');
  });

  it('rejects a malformed id with 400', async () => {
    const response = await authed('/api/docker/containers/..%2Fetc%2Fpasswd');
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for an unknown container', async () => {
    const response = await authed('/api/docker/containers/doesnotexist');
    expect(response.statusCode).toBe(404);
  });
});

describe('container control', () => {
  it('stops a normal container and writes an audit row', async () => {
    const response = await authed(`/api/docker/containers/${WEB_ID}/stop`, 'POST', true);

    expect(response.statusCode).toBe(200);
    expect(response.json().container.state).toBe('exited');
    expect(harness.docker.calls).toContain('stop:web');

    const audit = harness.db
      .prepare("SELECT action, actor, target FROM audit_log WHERE action = 'docker.container.stop'")
      .all() as { action: string; actor: string; target: string }[];

    expect(audit).toHaveLength(1);
    expect(audit[0]?.target).toContain('web');
  });

  it('refuses a protected container with 403 and audits the denial', async () => {
    const response = await authed(`/api/docker/containers/${PROXY_ID}/stop`, 'POST', true);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'container_protected' });
    expect(response.json().error).toContain('capturehost-socket-proxy');

    // Nothing was sent to Docker.
    expect(harness.docker.calls).not.toContain('stop:capturehost-socket-proxy');

    const denial = harness.db
      .prepare("SELECT target, success FROM audit_log WHERE action = 'docker.container.denied'")
      .get() as { target: string; success: number } | undefined;

    expect(denial?.target).toContain('capturehost-socket-proxy');
    expect(denial?.success).toBe(0);
  });

  it('refuses to remove a protected container', async () => {
    const response = await authed(`/api/docker/containers/${PROXY_ID}`, 'DELETE', true);
    expect(response.statusCode).toBe(403);
  });

  it('refuses to remove a running container with 409', async () => {
    const response = await authed(`/api/docker/containers/${WEB_ID}`, 'DELETE', true);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('container_running');
  });

  it('removes a stopped container', async () => {
    const response = await authed(`/api/docker/containers/${DB_ID}`, 'DELETE', true);
    expect(response.statusCode).toBe(200);
    expect(response.json().removed.name).toBe('db');
  });

  it('requires CSRF on every state-changing route', async () => {
    for (const [method, url] of [
      ['POST', `/api/docker/containers/${WEB_ID}/start`],
      ['POST', `/api/docker/containers/${WEB_ID}/stop`],
      ['POST', `/api/docker/containers/${WEB_ID}/restart`],
      ['DELETE', `/api/docker/containers/${DB_ID}`],
    ] as const) {
      const response = await harness.app.inject({ method, url, headers: { cookie } });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().code).toBe('forbidden');
    }
  });

  it('rate-limits actions per session', async () => {
    const limit = 30; // DOCKER_ACTIONS_PER_MINUTE default

    let last = await authed(`/api/docker/containers/${WEB_ID}/stop`, 'POST', true);
    for (let index = 0; index < limit; index += 1) {
      last = await authed(`/api/docker/containers/${WEB_ID}/restart`, 'POST', true);
    }

    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
    expect(last.json().code).toBe('rate_limited');
  });
});

describe('websocket: /ws/docker/logs/:id', () => {
  const url = (id: string): string => `ws://127.0.0.1:${harness.port}/ws/docker/logs/${id}`;

  function collect(options: WebSocket.ClientOptions, id = WEB_ID, after?: (socket: WebSocket) => void) {
    return new Promise<{ frames: unknown[]; socket: WebSocket }>((resolve, reject) => {
      const frames: unknown[] = [];
      const socket = new WebSocket(url(id), options);

      socket.on('message', (data: WebSocket.RawData) => {
        const frame = JSON.parse(String(data)) as { type: string; payload: unknown };
        frames.push(frame);

        if (frame.type === 'open') {
          // Feed the fake log stream once the stream is opened.
          after?.(socket);
          harness.docker.logsStreams.at(-1)?.write('hello from the container\n');
        }
        if (frame.type === 'line') {
          socket.close();
          resolve({ frames, socket });
        }
      });

      socket.on('error', reject);
      setTimeout(() => reject(new Error(`timed out with ${frames.length} frames`)), 6000);
    });
  }

  function closeCode(options: WebSocket.ClientOptions, id = WEB_ID): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url(id), options);
      socket.on('close', (code: number) => resolve(code));
      socket.on('error', () => undefined);
      setTimeout(() => reject(new Error('server did not close the socket')), 4000);
    });
  }

  it('rejects a socket with no session', async () => {
    expect(await closeCode({ origin: 'http://localhost:5173' })).toBe(1008);
  });

  it('rejects a valid session from a foreign origin', async () => {
    expect(await closeCode({ origin: 'https://evil.example.com', headers: { Cookie: cookie } })).toBe(1008);
  });

  it('rejects a malformed container id', async () => {
    const code = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws/docker/logs/..%2Fetc`, {
        origin: 'http://localhost:5173',
        headers: { Cookie: cookie },
      });
      socket.on('close', (c: number) => resolve(c));
      socket.on('error', () => undefined);
    });
    expect(code).toBe(1008);
  });

  it('streams an open frame followed by log lines', async () => {
    const { frames } = await collect({ origin: 'http://localhost:5173', headers: { Cookie: cookie } });

    expect((frames[0] as { type: string }).type).toBe('open');
    const line = frames.find((frame) => (frame as { type: string }).type === 'line') as {
      payload: { line: string };
    };
    expect(line.payload.line).toBe('hello from the container');
  });

  it('audits opening a log stream', async () => {
    await collect({ origin: 'http://localhost:5173', headers: { Cookie: cookie } });

    const row = harness.db
      .prepare("SELECT actor, target, detail FROM audit_log WHERE action = 'docker.logs.open'")
      .get() as { actor: string; target: string; detail: string } | undefined;

    expect(row?.target).toContain('web');
    expect(row?.detail).toBe('tail 200');
  });
});

describe('websocket: /ws/docker/stats', () => {
  function waitForStats(options: WebSocket.ClientOptions) {
    return new Promise<{ hello: { type: string }; stats: { payload: { containers: unknown[] } } }>(
      (resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws/docker/stats`, options);
        let hello: { type: string } | null = null;

        socket.on('message', (data: WebSocket.RawData) => {
          const frame = JSON.parse(String(data)) as { type: string; payload: { containers: unknown[] } };
          if (frame.type === 'hello') hello = frame;
          if (frame.type === 'stats' && hello) {
            socket.close();
            resolve({ hello, stats: frame });
          }
        });

        socket.on('error', reject);
        setTimeout(() => reject(new Error('no stats frame')), 8000);
      },
    );
  }

  it('rejects a socket with no session', async () => {
    const code = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws/docker/stats`, {
        origin: 'http://localhost:5173',
      });
      socket.on('close', (c: number) => resolve(c));
      socket.on('error', () => undefined);
    });
    expect(code).toBe(1008);
  });

  it('sends hello then a stats snapshot for running containers', async () => {
    const { hello, stats } = await waitForStats({
      origin: 'http://localhost:5173',
      headers: { Cookie: cookie },
    });

    expect(hello.type).toBe('hello');
    expect(stats.payload.containers.length).toBe(2); // proxy + web are running
  });
});

import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isOriginAllowed } from '../src/utils/origin.js';
import { createTestDb, silentLogger, testConfig, type TestDb } from './helpers.js';

/** The whole suite shares one app instance per test; close it afterwards. */
async function startApp() {
  const testDb: TestDb = createTestDb();
  const app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    logger: silentLogger,
    gpuProbe: async () => null, // pretend: no GPU
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  return {
    app,
    port,
    close: async () => {
      await app.close();
      testDb.cleanup();
    },
  };
}

let current: Awaited<ReturnType<typeof startApp>> | null = null;

afterEach(async () => {
  if (current) {
    await current.close();
    current = null;
  }
});

describe('GET /api/health', () => {
  it('answers ok with a version and db status', async () => {
    current = await startApp();
    const response = await current.app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/metrics/history', () => {
  it('defaults to a 1h window at 60s buckets', async () => {
    current = await startApp();
    const response = await current.app.inject({ method: 'GET', url: '/api/metrics/history' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.range).toBe('1h');
    expect(body.bucketSeconds).toBe(60);
    expect(Array.isArray(body.points)).toBe(true);
  });

  it('rejects a range outside 1h|6h|24h', async () => {
    current = await startApp();
    const response = await current.app.inject({ method: 'GET', url: '/api/metrics/history?range=90d' });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('rejects a bucket outside the allowlist', async () => {
    current = await startApp();
    const response = await current.app.inject({ method: 'GET', url: '/api/metrics/history?range=1h&bucket=7' });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('caps rows for the worst-case range/bucket combination', async () => {
    current = await startApp();
    // 24h at 30s buckets would be 2880 points; the hard cap is 720.
    const response = await current.app.inject({
      method: 'GET',
      url: '/api/metrics/history?range=24h&bucket=30',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.truncated).toBe(true);
    expect(body.points.length).toBeLessThanOrEqual(720);
  });
});

describe('WS /ws/metrics origin enforcement', () => {
  it('closes the socket when Origin is missing', async () => {
    current = await startApp();

    const closedWith = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${current?.port}/ws/metrics`);
      socket.on('close', (code: number) => resolve(code));
      socket.on('error', () => {
        /* expected: the server closes immediately */
      });
      setTimeout(() => reject(new Error('server did not close the socket')), 4000);
    });

    expect(closedWith).toBe(1008);
  });

  it('closes the socket when Origin is a foreign site', async () => {
    current = await startApp();

    const closedWith = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${current?.port}/ws/metrics`, {
        origin: 'https://evil.example.com',
      });
      socket.on('close', (code: number) => resolve(code));
      socket.on('error', () => {});
      setTimeout(() => reject(new Error('server did not close the socket')), 4000);
    });

    expect(closedWith).toBe(1008);
  });

  it('accepts the configured origin and streams hello then a snapshot', async () => {
    current = await startApp();

    const frames = await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${current?.port}/ws/metrics`, {
        origin: 'http://localhost:5173',
      });

      socket.on('message', (data: WebSocket.RawData) => {
        received.push(String(data));
        if (received.length >= 2) {
          socket.close();
          resolve(received);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error(`only received ${received.length} frames`)), 8000);
    });

    const hello = JSON.parse(frames[0] ?? '{}') as { type: string; payload: { intervalMs: number } };
    const snapshot = JSON.parse(frames[1] ?? '{}') as {
      type: string;
      payload: { cpuPct: number; uptimeSeconds: number; gpuUtilPct: number | null };
    };

    expect(hello.type).toBe('hello');
    expect(hello.payload.intervalMs).toBe(2000);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.payload.cpuPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.payload.uptimeSeconds).toBeGreaterThan(0);
    expect(snapshot.payload.gpuUtilPct).toBeNull(); // stubbed probe
  });
});

describe('isOriginAllowed', () => {
  it('normalises trailing slashes and case', () => {
    expect(isOriginAllowed('HTTP://Localhost:5173/', ['http://localhost:5173'])).toBe(true);
  });

  it('rejects unknown, missing and lookalike origins', () => {
    const allowed = ['http://localhost:5173'];
    expect(isOriginAllowed('http://localhost:5174', allowed)).toBe(false);
    expect(isOriginAllowed('http://localhost:5173.evil.com', allowed)).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
  });
});

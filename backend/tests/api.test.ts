import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOriginAllowed } from '../src/utils/origin.js';
import { startApp, type AuthedApp } from './appHarness.js';

/**
 * Route-contract tests for the Phase 1 endpoints.
 *
 * Phase 2 put the metrics endpoints behind the auth guard, so every request
 * here now carries a session cookie — the validation behaviour underneath is
 * unchanged. Socket-level auth lives in auth-routes.test.ts.
 */

let harness: AuthedApp;
let cookie: string;

beforeEach(async () => {
  harness = await startApp();
  cookie = (await harness.login()).cookie;
});

afterEach(async () => {
  await harness.close();
});

describe('GET /api/health', () => {
  it('answers ok with a version and db status', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' });

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
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/metrics/history',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.range).toBe('1h');
    expect(body.bucketSeconds).toBe(60);
    expect(Array.isArray(body.points)).toBe(true);
  });

  it('rejects a range outside 1h|6h|24h', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/metrics/history?range=90d',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('rejects a bucket outside the allowlist', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/metrics/history?range=1h&bucket=7',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('caps rows for the worst-case range/bucket combination', async () => {
    // 24h at 30s buckets would be 2880 points; the hard cap is 720.
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/metrics/history?range=24h&bucket=30',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.truncated).toBe(true);
    expect(body.points.length).toBeLessThanOrEqual(720);
  });

  it('requires a session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/metrics/history' });
    expect(response.statusCode).toBe(401);
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

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createProject } from '../src/db/projects.repo.js';
import { listDomains } from '../src/db/domains.repo.js';
import type { CaddyService } from '../src/services/caddy.js';
import { startApp, type AuthedApp } from './appHarness.js';

/** Route-level contract for Phase 5: validation, CSRF, audit and sync calls. */

let harness: AuthedApp;
let cookie: string;
let csrf: string;
let projectId: number;
let synced: number;

function fakeCaddy(): CaddyService {
  synced = 0;

  return {
    sync: async () => {
      synced += 1;
      return { added: 1, removed: 0, repaired: 0, drift: true };
    },
    status: async () => ({
      reachable: true,
      mode: 'local',
      adminUrl: 'http://127.0.0.1:2019',
      appsListen: '127.0.0.1:8080',
      dashboardListen: '127.0.0.1:8090',
      dashboardHost: 'capturehost.localhost',
      version: '2.10.0',
      managedRoutes: 1,
      otherRoutes: 1,
      drift: false,
      lastSyncAt: Date.now(),
      lastSync: { added: 1, removed: 0, repaired: 0, drift: false },
      error: null,
    }),
    checkDomain: async () => ({ ok: true, status: 200, latencyMs: 12, httpsOk: null, error: null }),
    removeRoutesForProject: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
  } as unknown as CaddyService;
}

function authHeaders(): Record<string, string> {
  return { cookie, 'x-csrf-token': csrf };
}

async function addDomain(hostname: string): Promise<{ statusCode: number; body: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: authHeaders(),
    payload: { projectId, hostname },
  });

  return { statusCode: response.statusCode, body: response.body };
}

beforeEach(async () => {
  harness = await startApp({ caddy: fakeCaddy() });
  const login = await harness.login();
  cookie = login.cookie;
  csrf = login.csrfToken;

  projectId = createProject(harness.db, {
    name: 'domains-demo',
    slug: 'domains-demo',
    repoUrl: 'https://github.com/owner/repo',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    containerPort: 80,
    healthPath: null,
    cpuLimit: 0.5,
    memoryLimitMb: 512,
    pidsLimit: 256,
    webhookSecretEncrypted: null,
    githubTokenEncrypted: null,
    now: Date.now(),
  });
});

afterEach(async () => {
  await harness.close();
});

describe('POST /api/domains', () => {
  it('creates a domain and triggers a Caddy sync', async () => {
    const { statusCode } = await addDomain('hello.capturehost.localhost');

    expect(statusCode).toBe(200);
    expect(listDomains(harness.db).map((domain) => domain.hostname)).toEqual(['hello.capturehost.localhost']);
    expect(synced).toBe(1);
  });

  it('rejects an invalid hostname and audits the reason', async () => {
    const { statusCode } = await addDomain('my_app.capturehost.localhost');
    expect(statusCode).toBe(400);

    const audit = harness.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'domain.rejected'")
      .get() as { detail: string } | undefined;

    expect(audit?.detail).toMatch(/Underscore/);
    expect(listDomains(harness.db)).toHaveLength(0);
  });

  it('rejects a hostname outside the allowed base domain', async () => {
    const { statusCode } = await addDomain('hello.example.com');
    expect(statusCode).toBe(400);
  });

  it('refuses the dashboard hostname', async () => {
    const { statusCode } = await addDomain('capturehost.localhost');
    expect(statusCode).toBe(400);
  });

  it('refuses a duplicate hostname with 409', async () => {
    await addDomain('hello.capturehost.localhost');
    const second = await addDomain('hello.capturehost.localhost');
    expect(second.statusCode).toBe(409);
  });

  it('requires CSRF', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/domains',
      headers: { cookie },
      payload: { projectId, hostname: 'hello.capturehost.localhost' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('domain maintenance', () => {
  it('lists domains with a URL that matches the mode', async () => {
    await addDomain('hello.capturehost.localhost');
    const response = await harness.app.inject({ method: 'GET', url: '/api/domains', headers: { cookie } });

    const body = response.json() as { domains: { hostname: string; url: string; projectName: string }[] };
    expect(body.domains[0]?.url).toBe('http://hello.capturehost.localhost:8080');
    expect(body.domains[0]?.projectName).toBe('domains-demo');
  });

  it('enables and disables a domain', async () => {
    await addDomain('hello.capturehost.localhost');
    const domain = listDomains(harness.db)[0]!;

    const off = await harness.app.inject({
      method: 'PATCH',
      url: `/api/domains/${domain.id}`,
      headers: authHeaders(),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(listDomains(harness.db)[0]?.enabled).toBe(0);

    const on = await harness.app.inject({
      method: 'PATCH',
      url: `/api/domains/${domain.id}`,
      headers: authHeaders(),
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(listDomains(harness.db)[0]?.enabled).toBe(1);
  });

  it('deletes a domain', async () => {
    await addDomain('hello.capturehost.localhost');
    const domain = listDomains(harness.db)[0]!;

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/api/domains/${domain.id}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(listDomains(harness.db)).toHaveLength(0);
  });

  it('runs a health check and returns the result', async () => {
    await addDomain('hello.capturehost.localhost');
    const domain = listDomains(harness.db)[0]!;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/domains/${domain.id}/check`,
      headers: authHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: 200 });
  });

  it('returns 404 for an unknown domain', async () => {
    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/domains/999',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/caddy/status', () => {
  it('reports mode, listeners and route counts', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/caddy/status', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reachable: true,
      mode: 'local',
      appsListen: '127.0.0.1:8080',
      dashboardListen: '127.0.0.1:8090',
    });
  });
});

describe('GET /api/projects/:id/domains', () => {
  it('lists the domains attached to a project', async () => {
    await addDomain('hello.capturehost.localhost');
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/domains`,
      headers: { cookie },
    });

    const body = response.json() as { domains: { hostname: string }[] };
    expect(body.domains.map((domain) => domain.hostname)).toEqual(['hello.capturehost.localhost']);
  });
});

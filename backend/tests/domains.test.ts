import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, setProjectRuntime } from '../src/db/projects.repo.js';
import { createDomain, listDomains } from '../src/db/domains.repo.js';
import { CaddyService } from '../src/services/caddy.js';
import {
  assertAllowedUpstream,
  buildAppRoute,
  isAllowedUpstream,
  isManagedRoute,
  routeTag,
  upstreamPortOf,
  validateHostname,
  type UpstreamPolicy,
} from '../src/services/domains.js';
import { createTestDb, silentLogger, testConfig, type TestDb } from './helpers.js';

/**
 * Phase 5: hostnames, upstreams and the Caddy reconciler.
 *
 * The admin API is faked with a real HTTP server so the client code (paths,
 * bodies, ordering, PUT vs POST) is exercised for real — a mock function would
 * not catch a wrong URL.
 */

const policy: UpstreamPolicy = {
  portRangeStart: 8100,
  portRangeEnd: 8999,
  forbiddenPorts: [2375, 2019, 8787, 8090, 5173],
};

describe('validateHostname', () => {
  const hostPolicy = {
    allowedBaseDomains: ['localhost', 'capturehost.dev'],
    reservedHosts: ['capturehost.localhost', 'hooks.localhost'],
  };

  it('accepts a normal subdomain of an allowed base', () => {
    expect(validateHostname('hello.capturehost.localhost', hostPolicy)).toEqual({
      ok: true,
      hostname: 'hello.capturehost.localhost',
    });
    expect(validateHostname('app.capturehost.dev', hostPolicy).ok).toBe(true);
  });

  it('lowercases and trims before validating', () => {
    expect(validateHostname('  HELLO.CaptureHost.LocalHost  ', hostPolicy)).toEqual({
      ok: true,
      hostname: 'hello.capturehost.localhost',
    });
  });

  const rejected: Array<[string, string, RegExp]> = [
    ['empty', '', /empty/i],
    ['underscore', 'my_app.capturehost.localhost', /Underscore/i],
    ['wildcard', '*.capturehost.localhost', /Wildcard/i],
    ['ip address', '10.0.0.5', /IP addresses/i],
    ['trailing dot', 'hello.capturehost.localhost.', /dot/i],
    ['scheme', 'http://hello.capturehost.localhost', /bare name/i],
    ['port', 'hello.capturehost.localhost:8080', /bare name/i],
    ['path', 'hello.capturehost.localhost/x', /bare name/i],
    ['single label', 'localhost', /two labels/i],
    ['underscore inside', 'he_llo.capturehost.dev', /Underscore/i],
    ['label starting with dash', '-hello.capturehost.dev', /lowercase letters/i],
    ['label ending with dash', 'hello-.capturehost.dev', /lowercase letters/i],
    ['wrong base', 'hello.example.com', /must end with/i],
    ['reserved dashboard', 'capturehost.localhost', /reserved/i],
    ['reserved webhook', 'hooks.localhost', /reserved/i],
    ['label too long', `${'a'.repeat(64)}.capturehost.dev`, /63 characters/i],
    ['total too long', `${'a.'.repeat(130)}capturehost.dev`, /253 characters/i],
  ];

  for (const [label, hostname, pattern] of rejected) {
    it(`rejects ${label}`, () => {
      const result = validateHostname(hostname, hostPolicy);
      expect(result.ok, hostname).toBe(false);
      expect(result.reason).toMatch(pattern);
    });
  }

  it('does not accept a base domain in the middle of a name', () => {
    expect(validateHostname('capturehost.dev.evil.example', hostPolicy).ok).toBe(false);
  });
});

describe('upstream allowlist', () => {
  it('allows an app-range port', () => {
    expect(isAllowedUpstream(8100, policy)).toBe(true);
    expect(isAllowedUpstream(8999, policy)).toBe(true);
  });

  it('refuses the services CaptureHost runs on itself', () => {
    for (const port of [2375, 2019, 8787, 8090, 5173]) {
      expect(isAllowedUpstream(port, policy), String(port)).toBe(false);
      expect(() => assertAllowedUpstream(port, policy)).toThrow(/CaptureHost itself/);
    }
  });

  it('refuses anything outside the app range', () => {
    for (const port of [80, 443, 22, 8099, 9000, 0, 65_536]) {
      expect(isAllowedUpstream(port, policy), String(port)).toBe(false);
    }
  });
});

describe('buildAppRoute', () => {
  it('produces a host-matched reverse proxy with an @id tag', () => {
    const route = buildAppRoute({ id: 7, hostname: 'hello.capturehost.localhost' }, 8101, policy);

    expect(route['@id']).toBe('capturehost-7');
    expect(route.match).toEqual([{ host: ['hello.capturehost.localhost'] }]);
    expect(route.terminal).toBe(true);

    const handle = (route.handle as { handler: string; upstreams: { dial: string }[] }[])[0]!;
    expect(handle.handler).toBe('reverse_proxy');
    expect(handle.upstreams).toEqual([{ dial: '127.0.0.1:8101' }]);
  });

  it('refuses to build a route to a forbidden port', () => {
    for (const port of [2375, 2019, 8787]) {
      expect(() => buildAppRoute({ id: 1, hostname: 'x.capturehost.localhost' }, port, policy), String(port)).toThrow();
    }
  });

  it('reads the port back out of a route for drift detection', () => {
    const route = buildAppRoute({ id: 3, hostname: 'a.capturehost.localhost' }, 8123, policy);
    expect(upstreamPortOf(route)).toBe(8123);
    expect(upstreamPortOf({ handle: [] })).toBeNull();
  });

  it('only claims routes it tagged itself', () => {
    expect(isManagedRoute({ '@id': routeTag(12) })).toBe(true);
    expect(isManagedRoute({ '@id': 'something-else' })).toBe(false);
    expect(isManagedRoute({})).toBe(false);
  });
});

// ---------------------------------------------------------------- fake Caddy

interface FakeCaddy {
  server: Server;
  url: string;
  config: Record<string, unknown>;
  writes: number;
  stop: () => Promise<void>;
}

/** Routes the backend must never touch — it did not tag these. */
const FOREIGN = { '@id': 'someone-else', match: [{ host: ['other.localhost'] }], handle: [] };

function buildCaddyConfig(routes: unknown[]): Record<string, unknown> {
  return {
    apps: {
      http: {
        servers: {
          srv0: { listen: ['127.0.0.1:8080'], routes },
          dashboard: { listen: ['127.0.0.1:8090'], routes: [{ '@id': 'dash', handle: [] }] },
        },
      },
    },
  };
}

/**
 * Stand-in for the Caddy admin API.
 *
 * It implements the three calls the client actually makes — GET /config/,
 * POST to a server's routes (append) and DELETE /id/<tag> — so a wrong URL or a
 * PUT that Caddy would refuse shows up as a failing test rather than as a
 * surprise on a live machine.
 */
async function startFakeCaddy(
  routes: unknown[],
  options: { rejectWrites?: boolean } = {},
): Promise<FakeCaddy> {
  const state: FakeCaddy = {
    server: createServer(),
    url: '',
    config: buildCaddyConfig(routes),
    writes: 0,
    stop: async () => undefined,
  };

  const servers = (): Record<string, { routes?: unknown[] }> =>
    (state.config.apps as { http: { servers: Record<string, { routes?: unknown[] }> } }).http.servers;

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = request.url ?? '';

    if (request.method === 'GET' && url === '/config/') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state.config));
      return;
    }

    if (options.rejectWrites && request.method !== 'GET') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'nope' }));
      return;
    }

    // Append a route.
    if (request.method === 'POST' && /^\/config\/apps\/http\/servers\/[^/]+\/routes$/.test(url)) {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        const name = url.split('/')[5]!;
        const server = servers()[name]!;
        // Caddy takes an array when the list does not exist and a single route
        // when it does; the fake accepts either and appends.
        const parsed = JSON.parse(body) as unknown;
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        server.routes = [...(server.routes ?? []), ...incoming];
        state.writes += 1;
        response.writeHead(200);
        response.end('{}');
      });
      return;
    }

    // Delete by @id.
    if (request.method === 'DELETE' && url.startsWith('/id/')) {
      const tag = decodeURIComponent(url.slice('/id/'.length));
      let found = false;

      for (const server of Object.values(servers())) {
        const before = server.routes ?? [];
        const after = before.filter((route) => (route as { '@id'?: string })['@id'] !== tag);
        if (after.length !== before.length) found = true;
        server.routes = after;
      }

      state.writes += 1;
      response.writeHead(found ? 200 : 404);
      response.end('{}');
      return;
    }

    response.writeHead(404);
    response.end('{}');
  };

  state.server.on('request', handler);
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const { port } = state.server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  state.stop = () =>
    new Promise<void>((resolve) => {
      state.server.close(() => resolve());
    });

  return state;
}

describe('CaddyService', () => {
  let testDb: TestDb;
  let fake: FakeCaddy;
  let service: CaddyService;
  let projectId: number;

  async function setup(routes: unknown[] = [FOREIGN], options: { rejectWrites?: boolean } = {}): Promise<void> {
    testDb = createTestDb();
    fake = await startFakeCaddy(routes, options);

    const config = testConfig();
    config.caddy.adminUrl = fake.url;

    projectId = createProject(testDb.db, {
      name: 'caddy-demo',
      slug: 'caddy-demo',
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

    setProjectRuntime(testDb.db, projectId, { status: 'running', hostPort: 8100, containerId: 'c'.repeat(64) }, Date.now());

    service = new CaddyService({ db: testDb.db, config, logger: silentLogger });
  }

  function routes(): unknown[] {
    const servers = (fake.config.apps as { http: { servers: Record<string, { routes?: unknown[] }> } }).http.servers;
    return servers.srv0?.routes ?? [];
  }

  /** Routes for real hostnames — the 404 catch-all is not one of them. */
  function managed(): unknown[] {
    return routes().filter((route) => isManagedRoute(route) && String(route['@id']) !== 'capturehost-catchall');
  }

  function catchAllPresent(): boolean {
    return routes().some((route) => String(route['@id']) === 'capturehost-catchall');
  }

  afterEach(async () => {
    service?.stop();
    await fake.stop();
    testDb.cleanup();
  });

  it('adds a route for an enabled domain', async () => {
    await setup();
    createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });

    const result = await service.sync('test');

    expect(result.added).toBe(1);
    expect(managed()).toHaveLength(1);
    expect(upstreamPortOf(managed()[0])).toBe(8100);
    // The catch-all is written last so an unknown host still 404s.
    expect(String(routes().at(-1)!['@id'])).toBe('capturehost-catchall');
    expect(catchAllPresent()).toBe(true);
  });

  it('is idempotent: a second sync with no change writes nothing', async () => {
    await setup();
    createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });

    await service.sync('first');
    const writesAfterFirst = fake.writes;
    const second = await service.sync('second');

    expect(second.drift).toBe(false);
    expect(fake.writes).toBe(writesAfterFirst);
  });

  it('repairs drift after Caddy reloads and loses the routes', async () => {
    await setup();
    createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
    await service.sync('first');

    // Simulate `systemctl reload caddy`: API routes are gone, the file is back.
    (fake.config as never as { apps: { http: { servers: Record<string, { routes: unknown[] }> } } }).apps.http.servers
      .srv0!.routes = [FOREIGN];

    const repaired = await service.sync('after-reload');

    expect(repaired.added).toBe(1);
    expect(managed()).toHaveLength(1);
    expect(catchAllPresent()).toBe(true);
  });

  it('replaces a route whose upstream changed (blue/green)', async () => {
    await setup();
    const id = createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
    await service.sync('first');

    await service.applyRoutesForProject(projectId, 8105);

    expect(managed()).toHaveLength(1);
    expect(upstreamPortOf(managed()[0])).toBe(8105);
    expect(String(managed()[0]!['@id'])).toBe(routeTag(id));
  });

  it('removes the route when the domain row is deleted', async () => {
    await setup();
    const id = createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
    await service.sync('add');

    testDb.db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    const result = await service.sync('delete');

    expect(result.removed).toBe(1);
    expect(managed()).toHaveLength(0);
    expect(catchAllPresent()).toBe(true);
  });

  it('removes the route when a domain is disabled', async () => {
    await setup();
    const id = createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
    await service.sync('add');

    testDb.db.prepare('UPDATE domains SET enabled = 0 WHERE id = ?').run(id);
    await service.sync('disable');

    expect(managed()).toHaveLength(0);
    expect(catchAllPresent()).toBe(true);
  });

  it('skips a project that has no container running yet', async () => {
    await setup();
    createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
    setProjectRuntime(testDb.db, projectId, { containerId: null, hostPort: null }, Date.now());

    const result = await service.sync('test');

    expect(result.added).toBe(0);
    expect(managed()).toHaveLength(0);
  });

  it('never touches routes it did not create', async () => {
    await setup([FOREIGN]);
    createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });

    await service.sync('test');

    expect(managed()).toHaveLength(1);
    expect(routes()).toContain(FOREIGN);
  });

  it('removes only its own project routes on project delete', async () => {
    await setup();
    const keep = createDomain(testDb.db, { projectId, hostname: 'keep.capturehost.localhost', now: Date.now() });
    const drop = createDomain(testDb.db, { projectId, hostname: 'drop.capturehost.localhost', now: Date.now() });
    await service.sync('add');

    // Give `drop` to a second project, then delete that project's routes only.
    const otherProject = createProject(testDb.db, {
      name: 'other-project',
      slug: 'other-project',
      repoUrl: 'https://github.com/owner/other',
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

    testDb.db.prepare('UPDATE domains SET project_id = ? WHERE id = ?').run(otherProject, drop);

    await service.removeRoutesForProject(otherProject);

    const tags = managed().map((route) => String(route['@id']));
    expect(tags).toEqual([routeTag(keep)]);
  });

  it('surfaces a Caddy write failure as an error', async () => {
    await setup([FOREIGN], { rejectWrites: true });
    createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });

    await expect(service.sync('test')).rejects.toThrow(/Caddy refused/);
  });

  it('reports route counts and mode in status()', async () => {
    await setup();
    createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
    await service.sync('test');

    const status = await service.status();

    expect(status.reachable).toBe(true);
    expect(status.mode).toBe('local');
    expect(status.appsListen).toBe('127.0.0.1:8080');
    expect(status.managedRoutes).toBe(1);
    expect(status.otherRoutes).toBe(1);
  });

  it('reports unreachable instead of throwing when Caddy is down', async () => {
    await setup();
    await fake.stop();

    const status = await service.status();

    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/Caddy/);
  });

  it('refuses a non-loopback admin URL at construction', async () => {
    await setup();
    const config = testConfig();
    config.caddy.adminUrl = 'http://10.0.0.5:2019';

    expect(() => new CaddyService({ db: testDb.db, config, logger: silentLogger })).toThrow(/loopback/);
  });

  it('marks a domain active once its route is in place', async () => {
    await setup();
    const id = createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
    await service.sync('test');

    expect(listDomains(testDb.db).find((domain) => domain.id === id)?.status).toBe('active');
  });
});

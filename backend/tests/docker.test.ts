import { afterAll, describe, expect, it } from 'vitest';
import { ContainerIdSchema } from '../src/routes/docker.js';
import { DockerService, mapStats, parseDockerUptime, stripAnsi } from '../src/services/docker.js';
import { SessionRateLimiter } from '../src/utils/rateLimit.js';
import { createFakeDocker, type FakeContainerSpec } from './dockerFake.js';
import { silentLogger, testConfig } from './helpers.js';

const PROXY_ID = 'a'.repeat(64);
const WEB_ID = 'b'.repeat(64);
const DB_ID = 'c'.repeat(64);

const SPECS: FakeContainerSpec[] = [
  {
    id: PROXY_ID,
    name: 'capturehost-socket-proxy',
    image: 'tecnativa/docker-socket-proxy:0.2.0',
    state: 'running',
    labels: { 'capturehost.protected': 'true' },
  },
  {
    id: WEB_ID,
    name: 'web',
    image: 'nginx:1.27',
    state: 'running',
    ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }],
    env: ['PATH=/usr/bin', 'SESSION_SECRET=super-secret-value'],
  },
  { id: DB_ID, name: 'db', image: 'postgres:16', state: 'exited' },
];

function service(specs: FakeContainerSpec[] = SPECS) {
  const fake = createFakeDocker(specs);
  const instance = new DockerService({ config: testConfig(), logger: silentLogger, client: fake.client });
  return { fake, instance };
}

afterAll(() => {
  // nothing to tear down: the fake holds no timers
});

describe('container id validation', () => {
  it('accepts 64-char hex ids and normal names', () => {
    expect(ContainerIdSchema.safeParse(WEB_ID).success).toBe(true);
    expect(ContainerIdSchema.safeParse('web').success).toBe(true);
    expect(ContainerIdSchema.safeParse('my-app_2.1').success).toBe(true);
  });

  it('rejects shell-ish and path-ish input', () => {
    for (const bad of ['', '-rf', 'a b', 'web;rm -rf /', '../../etc/passwd', 'name\n', 'a/b', '$(id)']) {
      expect(ContainerIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('list mapping', () => {
  it('maps names, state, ports and images', async () => {
    const { instance } = service();
    const list = await instance.list();

    expect(list).toHaveLength(3);

    const web = list.find((container) => container.name === 'web');
    expect(web).toMatchObject({ image: 'nginx:1.27', state: 'running' });
    expect(web?.ports).toEqual([{ privatePort: 80, publicPort: 8080, type: 'tcp', ip: '0.0.0.0' }]);
    expect(web?.shortId).toBe(WEB_ID.slice(0, 12));

    const db = list.find((container) => container.name === 'db');
    expect(db?.state).toBe('exited');
  });

  it('marks the socket proxy as protected via its label', async () => {
    const { instance } = service();
    const list = await instance.list();
    const proxy = list.find((container) => container.name === 'capturehost-socket-proxy');

    expect(proxy?.protected).toBe(true);
    expect(proxy?.protectedReason).toContain('capturehost.protected');
  });

  it('also protects by configured name and by id prefix', async () => {
    const fake = createFakeDocker([{ id: WEB_ID, name: 'web', state: 'running' }]);
    const instance = new DockerService({
      config: testConfig({
        docker: {
          hostUrl: 'http://127.0.0.1:2375',
          timeoutMs: 2000,
          statsIntervalMs: 2500,
          // Both a name and a short id, the two things an operator would paste.
          protectedContainers: ['capturehost-socket-proxy', 'bbbbbb'],
          actionsPerMinute: 30,
        },
      }),
      logger: silentLogger,
      client: fake.client,
    });

    expect(instance.isProtected({ name: 'capturehost-socket-proxy', id: PROXY_ID, labels: {} })).toMatchObject({
      protected: true,
    });
    // id prefix from the config list
    expect(instance.isProtected({ name: 'web', id: WEB_ID, labels: {} }).protected).toBe(true);
    // a completely unrelated container stays controllable
    expect(instance.isProtected({ name: 'other', id: DB_ID, labels: {} }).protected).toBe(false);
  });
});

describe('control', () => {
  it('refuses to stop a protected container', async () => {
    const { instance, fake } = service();

    await expect(instance.action(PROXY_ID, 'stop')).rejects.toMatchObject({
      statusCode: 403,
      code: 'container_protected',
    });
    // The refusal happens before any Docker call is made.
    expect(fake.calls).not.toContain('stop:capturehost-socket-proxy');
  });

  it('refuses to remove a protected container', async () => {
    const { instance } = service();
    await expect(instance.remove(PROXY_ID)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('stops a normal running container', async () => {
    const { instance, fake } = service();
    const result = await instance.action('web', 'stop');

    expect(result.name).toBe('web');
    expect(fake.calls).toContain('stop:web');
    expect((await instance.resolve('web')).state).toBe('exited');
  });

  it('refuses to remove a running container with 409', async () => {
    const { instance } = service();
    await expect(instance.remove('web')).rejects.toMatchObject({
      statusCode: 409,
      code: 'container_running',
    });
  });

  it('removes a stopped container', async () => {
    const { instance } = service();
    const result = await instance.remove('db');
    expect(result.name).toBe('db');
    await expect(instance.resolve('db')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('maps a "not running" refusal from Docker onto 409', async () => {
    const { instance, fake } = service();
    // Starting an already-running container: docker answers 304.
    fake.setState('web', 'running');
    await expect(instance.action('web', 'start')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reports an unknown container as 404', async () => {
    const { instance } = service();
    await expect(instance.action('nope', 'stop')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('docker unavailable', () => {
  it('status degrades instead of throwing when the proxy is down', async () => {
    const { instance, fake } = service();
    fake.setAvailable(false);

    const status = await instance.status();
    expect(status.available).toBe(false);
    expect(status.error).toBe('Docker proxy unreachable');
  });

  it('list throws a 503 the route can translate', async () => {
    const { instance, fake } = service();
    fake.setAvailable(false);

    await expect(instance.list()).rejects.toMatchObject({
      statusCode: 503,
      code: 'docker_unavailable',
    });
  });
});

describe('inspect', () => {
  it('never returns environment variable values', async () => {
    const { instance } = service();
    const inspect = await instance.inspect('web');

    expect(inspect.config.envKeys).toEqual(['PATH', 'SESSION_SECRET']);
    expect(JSON.stringify(inspect)).not.toContain('super-secret-value');
    expect(inspect.config.restartPolicy.name).toBe('unless-stopped');
    expect(inspect.ports[0]).toMatchObject({ privatePort: 80, publicPort: 8080 });
  });
});

describe('stats maths', () => {
  it('computes cpu % and subtracts cache from memory', () => {
    const sample = mapStats('web', {
      cpu_stats: {
        cpu_usage: { total_usage: 3_000_000, percpu_usage: [1, 1, 1, 1] },
        system_cpu_usage: 20_000_000,
        online_cpus: 4,
      },
      precpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 12_000_000 },
      memory_stats: { usage: 200 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { cache: 50 * 1024 * 1024 } },
      networks: { eth0: { rx_bytes: 1024, tx_bytes: 2048 } },
      pids_stats: { current: 7 },
    } as never);

    // (1e6 / 8e6) * 4 cpus * 100 = 50 %
    expect(sample.cpuPct).toBe(50);
    expect(sample.memUsedBytes).toBe(150 * 1024 * 1024);
    expect(sample.memPct).toBeCloseTo(14.65, 1);
    expect(sample.netRxBytes).toBe(1024);
    expect(sample.pids).toBe(7);
  });

  it('returns 0 % on a first sample with no previous counters', () => {
    const sample = mapStats('web', {
      cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 0 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: { usage: 0, limit: 0 },
    } as never);

    expect(sample.cpuPct).toBe(0);
    expect(sample.memPct).toBe(0);
  });
});

describe('uptime parsing', () => {
  it('parses the strings Docker puts in the list API', () => {
    expect(parseDockerUptime('Up 8 minutes')).toBe(480);
    expect(parseDockerUptime('Up About a minute')).toBe(60);
    expect(parseDockerUptime('Up Less than a second')).toBe(1);
    expect(parseDockerUptime('Up 3 hours')).toBe(10_800);
    expect(parseDockerUptime('Up 2 days (healthy)')).toBe(172_800);
    expect(parseDockerUptime('Up 3 weeks')).toBe(1_814_400);
  });

  it('refuses to invent an uptime for anything it does not recognise', () => {
    expect(parseDockerUptime('Exited (0) 3 months ago')).toBeNull();
    expect(parseDockerUptime('Created')).toBeNull();
    expect(parseDockerUptime('Up something odd')).toBeNull();
    expect(parseDockerUptime('')).toBeNull();
  });

  it('derives startedAt for a running container so the table shows an uptime', async () => {
    const { instance } = service([
      { id: WEB_ID, name: 'web', state: 'running', statusText: 'Up 5 minutes' },
    ]);

    const [container] = await instance.list();
    expect(container?.startedAt).toBeGreaterThan(Date.now() - 5 * 60_000 - 5000);
    expect(container?.startedAt).toBeLessThan(Date.now());
  });
});

describe('log sanitising', () => {
  it('strips ANSI colour codes but keeps the text', () => {
    expect(stripAnsi('\u001b[31mERROR\u001b[0m boom')).toBe('ERROR boom');
    expect(stripAnsi('\u001b[1;32mok\u001b[39m')).toBe('ok');
    expect(stripAnsi('plain line')).toBe('plain line');
  });
});

describe('action rate limiter', () => {
  it('allows the budget then refuses with retry-after', () => {
    const limiter = new SessionRateLimiter(3, 60_000);
    const now = 1_700_000_000_000;

    expect(limiter.consume('session-a', now).allowed).toBe(true);
    expect(limiter.consume('session-a', now).allowed).toBe(true);
    expect(limiter.consume('session-a', now).allowed).toBe(true);

    const blocked = limiter.consume('session-a', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // A different session has its own budget.
    expect(limiter.consume('session-b', now).allowed).toBe(true);
  });

  it('lets the window slide', () => {
    const limiter = new SessionRateLimiter(1, 1000);
    const start = 1_700_000_000_000;

    expect(limiter.consume('s', start).allowed).toBe(true);
    expect(limiter.consume('s', start + 500).allowed).toBe(false);
    expect(limiter.consume('s', start + 1500).allowed).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/services/auth.js';
import { ContainerWatcher, type WatcherDocker } from '../src/services/containerWatcher.js';
import { DomainMonitor } from '../src/services/domainMonitor.js';
import { RejectionTracker } from '../src/routes/webhook.js';
import { createProject, setProjectRuntime } from '../src/db/projects.repo.js';
import { createDomain, getDomain } from '../src/db/domains.repo.js';
import { createTestDb, seedAdmin, silentLogger, testConfig, type TestDb } from './helpers.js';
import type { ContainerSummary } from '../src/services/docker.js';
import type { NotificationService } from '../src/services/notifications.js';

/**
 * The four alerting paths that only matter while you are away: a managed
 * container dying, a domain failing repeatedly, an IP being locked out, and a
 * webhook being hammered with bad signatures.
 */

function recorder(): { notify: NotificationService['notify']; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];

  return {
    calls,
    notify: (async (input: Record<string, unknown>) => {
      calls.push(input);
      return { stored: true, delivered: false };
    }) as unknown as NotificationService['notify'],
  };
}

function container(overrides: Partial<ContainerSummary> & { id: string; name: string }): ContainerSummary {
  return {
    shortId: overrides.id.slice(0, 12),
    image: 'capturehost/demo:abc1234',
    state: 'running',
    statusText: 'Up',
    ports: [],
    createdAt: Date.now(),
    startedAt: Date.now(),
    labels: { 'capturehost.managed': 'true', 'capturehost.project': '1' },
    protected: false,
    protectedReason: null,
    ...overrides,
  } as ContainerSummary;
}

// ------------------------------------------------------------ containers

describe('ContainerWatcher', () => {
  function makeWatcher(options: {
    containers: ContainerSummary[];
    runtime?: { exitCode: number; restartCount: number };
  }) {
    const docker: WatcherDocker = {
      list: async () => options.containers,
      containerRuntime: async () => ({
        state: 'exited',
        exitCode: options.runtime?.exitCode ?? 0,
        restartCount: options.runtime?.restartCount ?? 0,
        labels: { 'capturehost.managed': 'true' },
      }),
    };

    const rec = recorder();
    const watcher = new ContainerWatcher({ docker, notifications: rec as never, logger: silentLogger });
    return { watcher, rec };
  }

  it('alerts once when a managed container is in a restart loop', async () => {
    const { watcher, rec } = makeWatcher({
      containers: [container({ id: 'a'.repeat(64), name: 'web-1', state: 'restarting' as never })],
      runtime: { exitCode: 1, restartCount: 7 },
    });

    expect(await watcher.poll()).toBe(1);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ event: 'container.restart_loop', severity: 'error' });
    expect(String(rec.calls[0]?.body)).toContain('web-1');

    // A second poll in the same state must not repeat it.
    expect(await watcher.poll()).toBe(0);
    expect(rec.calls).toHaveLength(1);
  });

  it('ignores containers it did not create', async () => {
    const { watcher, rec } = makeWatcher({
      containers: [
        container({
          id: 'b'.repeat(64),
          name: 'someone-else',
          state: 'restarting' as never,
          labels: {},
        }),
      ],
    });

    expect(await watcher.poll()).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it('alerts when a container that was running has exited', async () => {
    const running = container({ id: 'c'.repeat(64), name: 'web-2' });
    const exited = container({ id: 'c'.repeat(64), name: 'web-2', state: 'exited' as never });

    const list = vi.fn<() => Promise<ContainerSummary[]>>().mockResolvedValueOnce([running]).mockResolvedValue([exited]);
    const docker: WatcherDocker = {
      list,
      containerRuntime: async () => ({ state: 'exited', exitCode: 137, restartCount: 0, labels: {} }),
    };

    const rec = recorder();
    const watcher = new ContainerWatcher({ docker, notifications: rec as never, logger: silentLogger });

    expect(await watcher.poll()).toBe(0);
    expect(await watcher.poll()).toBe(1);
    expect(rec.calls[0]).toMatchObject({ event: 'container.exited' });
    expect(String(rec.calls[0]?.body)).toContain('137');
  });

  it('stays quiet when a container exits cleanly before it was ever running', async () => {
    const { watcher, rec } = makeWatcher({
      containers: [container({ id: 'd'.repeat(64), name: 'web-3', state: 'exited' as never })],
      runtime: { exitCode: 0, restartCount: 0 },
    });

    expect(await watcher.poll()).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- domains

describe('DomainMonitor', () => {
  let testDb: TestDb;
  let domainId: number;

  beforeEach(() => {
    testDb = createTestDb();

    const projectId = createProject(testDb.db, {
      name: 'monitor-demo',
      slug: 'monitor-demo',
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
    domainId = createDomain(testDb.db, { projectId, hostname: 'hello.capturehost.localhost', now: Date.now() });
  });

  afterEach(() => {
    testDb.cleanup();
  });

  function monitorWith(result: { ok: boolean }) {
    const rec = recorder();
    const monitor = new DomainMonitor({
      db: testDb.db,
      caddy: {
        checkDomain: async () => ({
          ok: result.ok,
          status: result.ok ? 200 : 502,
          latencyMs: 12,
          httpsOk: null,
          error: result.ok ? null : 'HTTP 502',
        }),
      },
      notifications: rec as never,
      logger: silentLogger,
    });

    return { monitor, rec };
  }

  it('stays quiet for the first two failures and alerts on the third', async () => {
    const { monitor, rec } = monitorWith({ ok: false });

    const first = await monitor.checkOne(domainId);
    const second = await monitor.checkOne(domainId);
    const third = await monitor.checkOne(domainId);

    expect(first.consecutiveFailures).toBe(1);
    expect(second.consecutiveFailures).toBe(2);
    expect(third.consecutiveFailures).toBe(3);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ event: 'domain.check_failed', severity: 'error' });
    expect(String(rec.calls[0]?.title)).toContain('hello.capturehost.localhost');
  });

  it('keeps counting past the threshold without re-alerting', async () => {
    const { monitor, rec } = monitorWith({ ok: false });

    for (let i = 0; i < 5; i += 1) await monitor.checkOne(domainId);

    expect(getDomain(testDb.db, domainId)?.consecutive_failures).toBe(5);
    expect(rec.calls).toHaveLength(1);
  });

  it('alerts on recovery after an outage', async () => {
    const failing = monitorWith({ ok: false });
    for (let i = 0; i < 3; i += 1) await failing.monitor.checkOne(domainId);

    const healthy = monitorWith({ ok: true });
    const outcome = await healthy.monitor.checkOne(domainId);

    expect(outcome.ok).toBe(true);
    expect(outcome.consecutiveFailures).toBe(0);
    expect(healthy.rec.calls[0]).toMatchObject({ event: 'domain.recovered', severity: 'info' });
  });

  it('does not report a recovery when there was no outage', async () => {
    const { monitor, rec } = monitorWith({ ok: true });
    await monitor.checkOne(domainId);

    expect(rec.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- auth

describe('login lockout alert', () => {
  it('reports the IP when a lockout trips, and never the password', async () => {
    const testDb = createTestDb();
    try {
      await seedAdmin(testDb.db);

      const auth = new AuthService({ db: testDb.db, config: testConfig(), logger: silentLogger });
      const lockouts: Array<{ ip: string; retryAfterSeconds: number }> = [];
      auth.onLockout = (info) => lockouts.push(info);

      const password = 'wrong-password-xyz-9';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await auth
          .login('admin', password, { ip: '203.0.113.9', userAgent: 'test' } as never)
          .catch(() => undefined);
      }

      expect(lockouts.length).toBeGreaterThan(0);
      expect(lockouts[0]?.ip).toBe('203.0.113.9');
      expect(JSON.stringify(lockouts)).not.toContain(password);
    } finally {
      testDb.cleanup();
    }
  });
});

// ---------------------------------------------------------------- webhooks

describe('RejectionTracker', () => {
  it('counts only rejections inside the window', () => {
    const tracker = new RejectionTracker(5, 10 * 60_000);
    const start = 1_000_000;

    expect(tracker.record(1, start)).toBe(1);
    expect(tracker.record(1, start + 1000)).toBe(2);
    expect(tracker.record(1, start + 2000)).toBe(3);

    // A later burst: the old three have aged out of the ten-minute window.
    expect(tracker.record(1, start + 11 * 60_000)).toBe(1);
  });

  it('keeps projects apart', () => {
    const tracker = new RejectionTracker(5);
    expect(tracker.record(1)).toBe(1);
    expect(tracker.record(2)).toBe(1);
    expect(tracker.record(1)).toBe(2);
  });

  it('resets after the threshold is reported', () => {
    const tracker = new RejectionTracker(2);
    expect(tracker.record(1)).toBe(1);
    expect(tracker.record(1)).toBe(2);
    tracker.reset(1);
    expect(tracker.record(1)).toBe(1);
  });
});

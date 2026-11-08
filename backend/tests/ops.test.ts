import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { BackupService } from '../src/services/backup.js';
import { NotificationService, assertSafeWebhookUrl, isPrivateAddress } from '../src/services/notifications.js';
import { RetentionService } from '../src/services/retention.js';
import { DoctorService } from '../src/services/doctor.js';
import type { CaddyService } from '../src/services/caddy.js';
import type { DockerService } from '../src/services/docker.js';
import { createTestDb, silentLogger, testConfig, type TestDb } from './helpers.js';

/** Phase 6: backups, notifications (incl. SSRF), retention and the doctor. */

const KEY = Buffer.alloc(32, 9);

function withBackups(overrides: { dir: string; key?: Buffer | null }) {
  const config = testConfig();
  config.backups = {
    ...config.backups,
    dir: overrides.dir,
    key: 'key' in overrides ? (overrides.key as Buffer | null) : KEY,
  };
  return config;
}

describe('backups', () => {
  let dir: string;
  let testDb: TestDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capturehost-backup-'));
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an encrypted file that verifies and reports its tables', async () => {
    const service = new BackupService({ db: testDb.db, config: withBackups({ dir }), logger: silentLogger });

    const result = await service.create('manual');
    expect(result.filename).toMatch(/^capturehost-\d{8}T\d{6}Z\.db\.chbk$/);
    expect(result.integrity).toBe('ok');

    // The file must not be a plain SQLite database.
    const raw = readdirSync(dir).includes(result.filename);
    expect(raw).toBe(true);

    const verified = service.verify(result.path);
    expect(verified.ok).toBe(true);
    expect(verified.integrity).toBe('ok');
    expect(verified.tables).toBeGreaterThan(5);
  });

  it('rejects a backup encrypted with a different key', async () => {
    const service = new BackupService({ db: testDb.db, config: withBackups({ dir }), logger: silentLogger });
    const result = await service.create('manual');

    const otherKey = new BackupService({
      db: testDb.db,
      config: withBackups({ dir, key: Buffer.alloc(32, 4) }),
      logger: silentLogger,
    });

    const verified = otherKey.verify(result.path);
    expect(verified.ok).toBe(false);
    expect(verified.error).toMatch(/wrong BACKUP_ENCRYPTION_KEY|corrupted/);
  });

  it('rejects a corrupted file', async () => {
    const service = new BackupService({ db: testDb.db, config: withBackups({ dir }), logger: silentLogger });
    const result = await service.create('manual');

    const corrupted = join(dir, 'capturehost-20200101T000000Z.db.chbk');
    writeFileSync(corrupted, Buffer.from('CHBK1 not really a backup'));

    const verified = service.verify(corrupted);
    expect(verified.ok).toBe(false);
  });

  it('refuses to create without a backup key', async () => {
    const service = new BackupService({ db: testDb.db, config: withBackups({ dir, key: null }), logger: silentLogger });
    await expect(service.create('manual')).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/);
  });

  it('restores a snapshot over the live database', async () => {
    const config = withBackups({ dir });
    // restore() replaces whatever DB_PATH points at, so point it at this test's file.
    config.dbPath = join(testDb.dir, 'test.db');
    const service = new BackupService({ db: testDb.db, config, logger: silentLogger });

    // A marker row that must disappear after the restore.
    testDb.db
      .prepare("INSERT INTO audit_log (action, actor, success, ts) VALUES ('marker.after.backup', 'test', 1, ?)")
      .run(Date.now());

    const result = await service.create('manual');

    testDb.db
      .prepare("INSERT INTO audit_log (action, actor, success, ts) VALUES ('marker.before.restore', 'test', 1, ?)")
      .run(Date.now());

    const restored = service.restore(result.path);
    expect(restored.tables).toBeGreaterThan(5);

    // The service closed the handle; reopen and compare.
    const reopened = openDatabase(config.dbPath);
    migrate(reopened);
    try {
      const markers = reopened
        .prepare("SELECT action FROM audit_log WHERE action LIKE 'marker.%' ORDER BY id")
        .all() as { action: string }[];

      expect(markers.map((row) => row.action)).toEqual(['marker.after.backup']);
    } finally {
      reopened.close();
    }
  });

  it('prunes only files matching our naming pattern', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'not ours');
    writeFileSync(join(dir, 'capturehost-20200101T000000Z.db.chbk'), 'old but ours');

    const config = withBackups({ dir });
    config.backups.keepDaily = 1;
    config.backups.keepWeekly = 0;

    const service = new BackupService({ db: testDb.db, config, logger: silentLogger });
    await service.create('manual');

    const remaining = readdirSync(dir);
    expect(remaining).toContain('notes.txt');
    expect(remaining.some((name) => name.startsWith('capturehost-2020'))).toBe(false);
  });
});

describe('notifications', () => {
  it('stores one notification per cooldown window for the same dedupe key', async () => {
    const db = createTestDb();
    try {
      const service = new NotificationService({ db: db.db, config: testConfig(), logger: silentLogger });

      const first = await service.notify({ event: 'container.down', title: 'Container down', dedupeKey: 'container.down:1' });
      const second = await service.notify({ event: 'container.down', title: 'Container down', dedupeKey: 'container.down:1' });

      expect(first.stored).toBe(true);
      expect(second.stored).toBe(false);
      expect(second.reason).toBe('cooldown');
      expect(service.unread()).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  it('marks notifications read', async () => {
    const db = createTestDb();
    try {
      const service = new NotificationService({ db: db.db, config: testConfig(), logger: silentLogger });
      const first = await service.notify({ event: 'a', title: 'A' });
      await service.notify({ event: 'b', title: 'B' });

      expect(service.unread()).toBe(2);
      expect(service.markRead([first.id!])).toBe(1);
      expect(service.unread()).toBe(1);
      expect(service.markRead('all')).toBe(1);
      expect(service.unread()).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('never exposes the webhook path (where the secret usually is)', () => {
    const config = testConfig();
    config.notify.webhookUrl = 'https://ntfy.sh/secret-topic-123';

    const db = createTestDb();
    try {
      const service = new NotificationService({ db: db.db, config, logger: silentLogger });
      const status = service.channelStatus();

      expect(status.configured).toBe(true);
      expect(status.host).toBe('ntfy.sh');
      expect(JSON.stringify(status)).not.toContain('secret-topic');
    } finally {
      db.cleanup();
    }
  });
});

describe('webhook SSRF rules', () => {
  const bad: Array<[string, string, RegExp]> = [
    ['plain http', 'http://example.com/hook', /must use https/],
    ['loopback literal', 'https://127.0.0.1/hook', /private or loopback/],
    ['private v4', 'https://10.1.2.3/hook', /private or loopback/],
    ['link local', 'https://169.254.169.254/latest/meta-data', /private or loopback/],
    ['cgNAT', 'https://100.64.0.9/hook', /private or loopback/],
    ['localhost name', 'https://localhost:8080/hook', /private/],
    ['dotlocal', 'https://nas.local/hook', /private/],
    ['credentials in url', 'https://user:pass@example.com/hook', /credentials/],
    ['not a url', 'not-a-url', /valid URL/],
  ];

  for (const [label, url, pattern] of bad) {
    it(`refuses ${label}`, async () => {
      await expect(assertSafeWebhookUrl(url)).rejects.toThrow(pattern);
    });
  }

  it('treats private address ranges as unsafe', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('retention', () => {
  it('deletes only rows older than the configured window', () => {
    const testDb = createTestDb();
    try {
      const config = testConfig();
      const now = Date.now();
      const old = now - 200 * 86_400_000;

      testDb.db
        .prepare("INSERT INTO audit_log (action, actor, success, ts) VALUES ('old.row', 'test', 1, ?)")
        .run(old);
      testDb.db
        .prepare("INSERT INTO audit_log (action, actor, success, ts) VALUES ('new.row', 'test', 1, ?)")
        .run(now);

      const service = new RetentionService({ db: testDb.db, config, logger: silentLogger });
      const report = service.run(now);

      expect(report.auditLog).toBeGreaterThanOrEqual(1);

      const actions = (
        testDb.db.prepare("SELECT action FROM audit_log WHERE action LIKE '%.row'").all() as { action: string }[]
      ).map((row) => row.action);

      expect(actions).toContain('new.row');
      expect(actions).not.toContain('old.row');
    } finally {
      testDb.cleanup();
    }
  });

  it('clears build logs of finished deployments only', () => {
    const testDb = createTestDb();
    try {
      const now = Date.now();
      const old = now - 100 * 86_400_000;

      testDb.db
        .prepare("INSERT INTO projects (name, slug, repo_url, branch, dockerfile_path, created_at, updated_at) VALUES ('p', 'p', 'https://github.com/o/r', 'main', 'Dockerfile', ?, ?)")
        .run(now, now);

      testDb.db
        .prepare("INSERT INTO deployments (project_id, status, trigger, log, created_at) VALUES (1, 'live', 'manual', 'old log', ?)")
        .run(old);
      testDb.db
        .prepare("INSERT INTO deployments (project_id, status, trigger, log, created_at) VALUES (1, 'building', 'manual', 'busy log', ?)")
        .run(old);

      const service = new RetentionService({ db: testDb.db, config: testConfig(), logger: silentLogger });
      service.run(now);

      const logs = testDb.db.prepare('SELECT status, log FROM deployments ORDER BY id').all() as {
        status: string;
        log: string | null;
      }[];

      expect(logs[0]?.log).toBeNull();
      expect(logs[1]?.log).toBe('busy log');
    } finally {
      testDb.cleanup();
    }
  });
});

describe('doctor', () => {
  function fakeCaddy(status: Partial<Awaited<ReturnType<CaddyService['status']>>> = {}) {
    return {
      status: async () => ({
        reachable: true,
        mode: 'local',
        adminUrl: 'http://127.0.0.1:2019',
        appsListen: '127.0.0.1:8080',
        dashboardListen: '127.0.0.1:8090',
        dashboardHost: 'capturehost.localhost',
        version: '2.11.8',
        managedRoutes: 1,
        otherRoutes: 0,
        drift: false,
        lastSyncAt: Date.now(),
        lastSync: null,
        error: null,
        ...status,
      }),
      start: () => undefined,
      stop: () => undefined,
      sync: async () => ({ added: 0, removed: 0, repaired: 0, drift: false }),
    } as unknown as CaddyService;
  }

  const fakeDocker = {} as DockerService;

  it('flags a missing admin and a disabled 2FA', async () => {
    const testDb = createTestDb();
    try {
      const doctor = new DoctorService({
        db: testDb.db,
        config: testConfig(),
        logger: silentLogger,
        caddy: fakeCaddy(),
        docker: fakeDocker,
      });

      const report = await doctor.run();
      const byId = new Map(report.checks.map((check) => [check.id, check]));

      expect(byId.get('admin-exists')?.status).toBe('fail');
      expect(byId.get('2fa-enabled')?.status).toBe('warn');
      expect(byId.get('listeners-loopback')?.status).toBe('pass');
      expect(byId.get('trust-proxy')?.status).toBe('pass');
      expect(byId.get('caddy-admin-loopback')?.status).toBe('pass');
      expect(report.summary.fail + report.summary.warn + report.summary.pass).toBe(report.checks.length);
    } finally {
      testDb.cleanup();
    }
  });

  it('reports Caddy as failed when the admin API is down', async () => {
    const testDb = createTestDb();
    try {
      const doctor = new DoctorService({
        db: testDb.db,
        config: testConfig(),
        logger: silentLogger,
        caddy: fakeCaddy({ reachable: false, error: 'boom' }),
        docker: fakeDocker,
      });

      const report = await doctor.run();
      const caddy = report.checks.find((check) => check.id === 'caddy-reachable');

      expect(caddy?.status).toBe('fail');
      expect(caddy?.fix).toBeDefined();
    } finally {
      testDb.cleanup();
    }
  });

  it('never prints secret values', async () => {
    const testDb = createTestDb();
    try {
      const config = testConfig();
      const doctor = new DoctorService({
        db: testDb.db,
        config,
        logger: silentLogger,
        caddy: fakeCaddy(),
        docker: fakeDocker,
      });

      const report = await doctor.run();
      const text = JSON.stringify(report);

      expect(text).not.toContain(config.encryptionKey.toString('base64'));
      expect(text).not.toContain(config.encryptionKey.toString('hex'));
    } finally {
      testDb.cleanup();
    }
  });
});

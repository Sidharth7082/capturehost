import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { AppConfig } from '../src/config.js';
import { hashPassword } from '../src/crypto/password.js';
import { createAdmin } from '../src/db/auth.repo.js';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

export const silentLogger = pino({ level: 'silent' });

export interface TestDb {
  db: Db;
  dir: string;
  cleanup: () => void;
}

/** Fresh on-disk database (WAL needs a real file) with migrations applied. */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'capturehost-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);

  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createMemoryDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    logLevel: 'silent',
    host: '127.0.0.1',
    port: 0,
    dbPath: ':memory:',
    allowedOrigins: ['http://localhost:5173'],
    metricsIntervalMs: 2000,
    metricsRetentionHours: 24,
    isProduction: false,
    encryptionKey: Buffer.alloc(32, 7),
    session: {
      idleMs: 30 * 60_000,
      absoluteMs: 12 * 60 * 60_000,
      pendingMs: 5 * 60_000,
      cookieName: 'capturehost_sid',
      secure: false,
    },
    // Deliberately weak for speed; production defaults are in config.ts.
    argon2: { memoryCost: 8192, timeCost: 2, parallelism: 1 },
    login: { maxFailures: 3, windowMs: 10 * 60_000, lockoutMs: 5 * 60_000 },
    trustProxy: false,
    trustProxyAddresses: ['127.0.0.1', '::1'],
    docker: {
      hostUrl: 'http://127.0.0.1:2375',
      timeoutMs: 2000,
      statsIntervalMs: 2500,
      protectedContainers: ['capturehost-socket-proxy'],
      actionsPerMinute: 30,
    },
    deploy: {
      dataDir: join(tmpdir(), 'capturehost-test-deployments'),
      buildTimeoutMs: 60_000,
      keepImages: 3,
      maxLogBytes: 65_536,
      maxCloneBytes: 10 * 1024 * 1024,
      actionsPerMinute: 10,
      gitTimeoutMs: 30_000,
      memoryDefaultMb: 512,
      memoryMaxMb: 4096,
      cpuDefault: 0.5,
      cpuMax: 4,
      pidsLimit: 256,
      portRangeStart: 8100,
      portRangeEnd: 8999,
      network: 'capturehost-apps',
      healthCheckTimeoutMs: 30_000,
    },
    webhook: { maxBodyBytes: 1_048_576 },
    backups: {
      dir: join(tmpdir(), 'capturehost-test-backups'),
      key: Buffer.alloc(32, 9),
      scheduleHours: 24,
      keepDaily: 7,
      keepWeekly: 4,
      maxAgeHours: 36,
    },
    notify: {
      webhookUrl: null,
      cooldownMs: 30 * 60_000,
      diskThresholdPct: 90,
      diskRecoverPct: 85,
      timeoutMs: 2000,
    },
    retention: {
      intervalMs: 3_600_000,
      auditDays: 90,
      deployLogDays: 30,
      deliveriesDays: 14,
      attemptsDays: 7,
      notificationsDays: 30,
    },
    github: {
      apiBase: 'https://api.github.com',
      timeoutMs: 2000,
      cacheTtlMs: 60_000,
      perPage: 30,
      expiryWarningDays: 14,
    },
    caddy: {
      mode: 'local',
      adminUrl: 'http://127.0.0.1:2019',
      appsListen: { host: '127.0.0.1', port: 8080 },
      dashboardHost: 'capturehost.localhost',
      dashboardListen: { host: '127.0.0.1', port: 8090 },
      timeoutMs: 2000,
      syncIntervalMs: 60_000,
      allowedBaseDomains: ['localhost'],
      webhookPublicHost: null,
    },
    ...overrides,
  };
}

export const TEST_USERNAME = 'admin';
export const TEST_PASSWORD = 'fixture-password-do-not-use';

/** Creates the single admin row the way setup:admin would. */
export async function seedAdmin(db: Db, password = TEST_PASSWORD): Promise<void> {
  const hash = await hashPassword(password, testConfig().argon2);
  createAdmin(db, { username: TEST_USERNAME, passwordHash: hash, now: Date.now() });
}


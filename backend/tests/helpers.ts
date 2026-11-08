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
    docker: {
      hostUrl: 'http://127.0.0.1:2375',
      timeoutMs: 2000,
      statsIntervalMs: 2500,
      protectedContainers: ['capturehost-socket-proxy'],
      actionsPerMinute: 30,
    },
    ...overrides,
  };
}

export const TEST_USERNAME = 'admin';
export const TEST_PASSWORD = 'correct-horse-battery-42';

/** Creates the single admin row the way setup:admin would. */
export async function seedAdmin(db: Db, password = TEST_PASSWORD): Promise<void> {
  const hash = await hashPassword(password, testConfig().argon2);
  createAdmin(db, { username: TEST_USERNAME, passwordHash: hash, now: Date.now() });
}


import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { AppConfig } from '../src/config.js';
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
    ...overrides,
  };
}

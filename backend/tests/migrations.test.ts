import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';
import { migrate } from '../src/db/migrate.js';

const EXPECTED_TABLES = [
  'admin',
  'sessions',
  'projects',
  'deployments',
  'domains',
  'env_vars',
  'metrics',
  'audit_log',
];

function tableNames(db: ReturnType<typeof createTestDb>['db']): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((row) => row.name).sort();
}

describe('migrations', () => {
  it('creates every table from the spec on a fresh database', () => {
    const { db, cleanup } = createTestDb();
    try {
      const names = tableNames(db);
      for (const table of EXPECTED_TABLES) {
        expect(names).toContain(table);
      }
      expect(names).toContain('schema_migrations');
    } finally {
      cleanup();
    }
  });

  it('is idempotent — a second run applies nothing', () => {
    const { db, cleanup } = createTestDb();
    try {
      const second = migrate(db);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it('enables WAL and foreign keys', () => {
    const { db, cleanup } = createTestDb();
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('rejects a single-admin table claim of more than one row', () => {
    const { db, cleanup } = createTestDb();
    try {
      const insert = db.prepare(
        'INSERT INTO admin (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run(1, 'admin', 'hash', 0, 0);
      // The CHECK (id = 1) constraint is what keeps "single admin" honest.
      expect(() => insert.run(2, 'second', 'hash', 0, 0)).toThrow();
    } finally {
      cleanup();
    }
  });

  it('cascades deployments when a project is deleted', () => {
    const { db, cleanup } = createTestDb();
    try {
      db.prepare(
        'INSERT INTO projects (name, repo_url, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run('demo', 'https://github.com/x/y', 0, 0);
      db.prepare('INSERT INTO deployments (project_id, created_at) VALUES (?, ?)').run(1, 0);

      db.prepare('DELETE FROM projects WHERE id = 1').run();

      const remaining = db.prepare('SELECT COUNT(*) AS c FROM deployments').get() as { c: number };
      expect(remaining.c).toBe(0);
    } finally {
      cleanup();
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationResult {
  /** Migration files applied during this run, in order. */
  applied: string[];
  /** Files that were already recorded in schema_migrations. */
  alreadyApplied: number;
}

interface MigrationRow {
  name: string;
}

/**
 * Tiny forward-only migration runner.
 *
 * Each `NNN_name.sql` file runs inside its own transaction together with the
 * row that records it, so a failed migration leaves no partial state behind.
 * Re-running is a no-op.
 */
export function migrate(db: Db, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT    PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort(); // NNN prefix makes lexical order the correct order

  const done = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as MigrationRow[]).map((row) => row.name),
  );

  const applied: string[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (done.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    // better-sqlite3 wraps a function in BEGIN/COMMIT and rolls back on throw.
    db.transaction(() => {
      db.exec(sql);
      record.run(file, Date.now());
    })();

    applied.push(file);
  }

  return { applied, alreadyApplied: done.size };
}

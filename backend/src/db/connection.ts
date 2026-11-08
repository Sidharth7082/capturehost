import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Db = Database.Database;

/**
 * Opens the SQLite file and applies the pragmas we rely on.
 *
 * WAL: readers never block the metrics writer.
 * busy_timeout: tolerate a short lock instead of throwing SQLITE_BUSY.
 * foreign_keys: SQLite ships with them OFF; the schema depends on them.
 * synchronous=NORMAL: safe with WAL, much faster than the default FULL.
 */
export function openDatabase(dbPath: string): Db {
  const absolutePath = dbPath === ':memory:' ? dbPath : resolve(dbPath);

  if (absolutePath !== ':memory:') {
    mkdirSync(dirname(absolutePath), { recursive: true });
  }

  const db = new Database(absolutePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

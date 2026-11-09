import type { Db } from './connection.js';

/**
 * Databases and the projects linked to them.
 *
 * The rows here are the source of truth for what exists; Docker is the source of
 * truth for what is running. The service reconciles the two and stores the
 * difference in `status` / `last_error` rather than guessing.
 */

export type DatabaseStatus = 'creating' | 'running' | 'stopped' | 'failed';

export interface DatabaseRow {
  id: number;
  name: string;
  engine: string;
  version: string;
  container_name: string;
  volume: string;
  port: number | null;
  status: DatabaseStatus;
  db_name: string;
  username: string;
  password_encrypted: string;
  created_at: number;
  updated_at: number;
  last_backup_at: number | null;
  last_error: string | null;
}

export interface DatabaseLinkRow {
  project_id: number;
  database_id: number;
  env_key: string;
  created_at: number;
  project_name?: string;
}

export function listDatabases(db: Db): DatabaseRow[] {
  return db.prepare('SELECT * FROM databases ORDER BY created_at DESC').all() as DatabaseRow[];
}

export function getDatabase(db: Db, id: number): DatabaseRow | null {
  return (db.prepare('SELECT * FROM databases WHERE id = ?').get(id) as DatabaseRow | undefined) ?? null;
}

export function getDatabaseByName(db: Db, name: string): DatabaseRow | null {
  return (db.prepare('SELECT * FROM databases WHERE name = ?').get(name) as DatabaseRow | undefined) ?? null;
}

export function createDatabase(
  db: Db,
  input: {
    name: string;
    version: string;
    containerName: string;
    volume: string;
    port: number | null;
    dbName: string;
    username: string;
    passwordEncrypted: string;
    now: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO databases
         (name, engine, version, container_name, volume, port, status, db_name, username,
          password_encrypted, created_at, updated_at)
       VALUES (@name, 'postgres', @version, @containerName, @volume, @port, 'creating', @dbName,
               @username, @passwordEncrypted, @now, @now)`,
    )
    .run({
      name: input.name,
      version: input.version,
      containerName: input.containerName,
      volume: input.volume,
      port: input.port,
      dbName: input.dbName,
      username: input.username,
      passwordEncrypted: input.passwordEncrypted,
      now: input.now,
    });

  return Number(result.lastInsertRowid);
}

export function setDatabaseStatus(
  db: Db,
  id: number,
  status: DatabaseStatus,
  update: { error?: string | null; port?: number | null; now?: number } = {},
): void {
  db.prepare(
    `UPDATE databases
        SET status = @status,
            last_error = @error,
            port = COALESCE(@port, port),
            updated_at = @now
      WHERE id = @id`,
  ).run({
    id,
    status,
    error: update.error ?? null,
    port: update.port ?? null,
    now: update.now ?? Date.now(),
  });
}

export function setLastBackupAt(db: Db, id: number, at: number): void {
  db.prepare('UPDATE databases SET last_backup_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
}

export function deleteDatabaseRow(db: Db, id: number): void {
  db.prepare('DELETE FROM databases WHERE id = ?').run(id);
}

// ------------------------------------------------------------------- links

export function linkProject(
  db: Db,
  input: { projectId: number; databaseId: number; envKey: string; now: number },
): void {
  db.prepare(
    `INSERT INTO project_databases (project_id, database_id, env_key, created_at)
     VALUES (@projectId, @databaseId, @envKey, @now)
     ON CONFLICT(project_id, database_id) DO UPDATE SET env_key = excluded.env_key`,
  ).run(input);
}

export function unlinkProject(db: Db, projectId: number, databaseId: number): boolean {
  const result = db
    .prepare('DELETE FROM project_databases WHERE project_id = ? AND database_id = ?')
    .run(projectId, databaseId);
  return result.changes > 0;
}

export function listLinksForDatabase(db: Db, databaseId: number): DatabaseLinkRow[] {
  return db
    .prepare(
      `SELECT pd.*, p.name AS project_name
         FROM project_databases pd
         JOIN projects p ON p.id = pd.project_id
        WHERE pd.database_id = ?
        ORDER BY pd.created_at`,
    )
    .all(databaseId) as DatabaseLinkRow[];
}

export function listLinksForProject(db: Db, projectId: number): DatabaseLinkRow[] {
  return db
    .prepare('SELECT * FROM project_databases WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as DatabaseLinkRow[];
}

export function linkFor(db: Db, projectId: number, databaseId: number): DatabaseLinkRow | null {
  return (
    (db
      .prepare('SELECT * FROM project_databases WHERE project_id = ? AND database_id = ?')
      .get(projectId, databaseId) as DatabaseLinkRow | undefined) ?? null
  );
}

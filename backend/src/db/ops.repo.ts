import type { Db } from './connection.js';

/** Backups + notifications: row shapes and the queries the services use. */

export interface BackupRow {
  id: number;
  filename: string;
  path: string;
  size_bytes: number;
  sha256: string;
  kind: 'scheduled' | 'manual';
  integrity: string;
  created_at: number;
}

export function listBackups(db: Db, limit = 100): BackupRow[] {
  return db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT ?').all(limit) as BackupRow[];
}

export function getBackup(db: Db, id: number): BackupRow | null {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as BackupRow | undefined;
  return row ?? null;
}

export interface NewBackup {
  filename: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  kind: 'scheduled' | 'manual';
  integrity: string;
  createdAt: number;
}

export function insertBackup(db: Db, input: NewBackup): number {
  const result = db
    .prepare(
      `INSERT INTO backups (filename, path, size_bytes, sha256, kind, integrity, created_at)
       VALUES (@filename, @path, @sizeBytes, @sha256, @kind, @integrity, @createdAt)`,
    )
    .run(input);

  return Number(result.lastInsertRowid);
}

export function deleteBackupRow(db: Db, id: number): void {
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
}

export function latestBackup(db: Db): BackupRow | null {
  const row = db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 1').get() as
    | BackupRow
    | undefined;
  return row ?? null;
}

// ------------------------------------------------------------ notifications

export interface NotificationRow {
  id: number;
  event: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string | null;
  dedupe_key: string | null;
  meta: string | null;
  created_at: number;
  read_at: number | null;
}

export function listNotifications(db: Db, limit = 50): NotificationRow[] {
  return db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit) as NotificationRow[];
}

export function unreadCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL').get() as {
    count: number;
  };
  return row.count;
}

export function insertNotification(
  db: Db,
  input: {
    event: string;
    severity: 'info' | 'warning' | 'error';
    title: string;
    body: string | null;
    dedupeKey: string | null;
    meta: string | null;
    now: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO notifications (event, severity, title, body, dedupe_key, meta, created_at)
       VALUES (@event, @severity, @title, @body, @dedupeKey, @meta, @now)`,
    )
    .run(input);

  return Number(result.lastInsertRowid);
}

/** Last time this dedupe key fired, for the cooldown window. */
export function lastNotificationAt(db: Db, dedupeKey: string): number | null {
  const row = db
    .prepare('SELECT created_at FROM notifications WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1')
    .get(dedupeKey) as { created_at: number } | undefined;

  return row?.created_at ?? null;
}

export function markRead(db: Db, ids: number[] | 'all', now: number): number {
  if (ids === 'all') {
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now);
    return result.changes;
  }

  if (ids.length === 0) return 0;

  const statement = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL');
  let changed = 0;
  for (const id of ids) changed += statement.run(now, id).changes;
  return changed;
}

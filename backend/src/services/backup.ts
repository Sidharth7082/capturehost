import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { deleteBackupRow, insertBackup, latestBackup, listBackups, type BackupRow } from '../db/ops.repo.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';

/**
 * Encrypted, integrity-checked SQLite backups.
 *
 * Why not `cp capturehost.db`: a live WAL database copied byte-for-byte can be
 * torn. `VACUUM INTO` / `.backup()` ask SQLite for a consistent snapshot
 * instead. The snapshot is then gzipped and AES-256-GCM encrypted with a key
 * that is deliberately NOT the one guarding env vars and tokens, so leaking one
 * does not open the other.
 *
 * File layout: "CHBK1" | 12-byte IV | 16-byte tag | gzip(ciphertext)
 * AAD binds the format to this application and to the schema generation.
 */

const MAGIC = Buffer.from('CHBK1', 'ascii');
const AAD = Buffer.from('capturehost-backup-v1', 'utf8');
const FILENAME_PATTERN = /^capturehost-\d{8}T\d{6}Z\.db\.chbk$/;

export interface BackupResult {
  filename: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  integrity: string;
  createdAt: number;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  tables: number;
  sizeBytes: number;
  createdAt: number | null;
  error: string | null;
}

export class BackupService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: { db: Db; config: AppConfig; logger: Logger }) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;
  }

  // ------------------------------------------------------------------ public

  /** Snapshot -> verify -> compress -> encrypt -> write -> record. */
  async create(kind: 'scheduled' | 'manual'): Promise<BackupResult> {
    const key = this.config.backups.key;
    if (!key) {
      throw new AppError(
        400,
        'backups_disabled',
        'Backups need BACKUP_ENCRYPTION_KEY in .env (32 bytes, openssl rand -base64 32)',
      );
    }

    const dir = resolve(this.config.backups.dir);
    mkdirSync(dir, { recursive: true });

    const createdAt = Date.now();
    const stamp = new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const filename = `capturehost-${stamp}.db.chbk`;
    const finalPath = join(dir, filename);
    const tmpPath = join(dir, `.tmp-${process.pid}-${createdAt}.db`);

    try {
      await this.snapshot(tmpPath);
      const integrity = this.integrityCheck(tmpPath);
      if (integrity !== 'ok') {
        throw new AppError(500, 'backup_integrity', `Backup failed its integrity check: ${integrity}`);
      }

      const plain = readFileSync(tmpPath);
      const payload = this.encrypt(gzipSync(plain, { level: 6 }), key);
      writeFileSync(finalPath, payload, { mode: 0o600 });

      const sha256 = createHash('sha256').update(payload).digest('hex');
      const sizeBytes = statSync(finalPath).size;

      insertBackup(this.db, {
        filename,
        path: finalPath,
        sizeBytes,
        sha256,
        kind,
        integrity,
        createdAt,
      });

      this.logger.info({ filename, sizeBytes, kind }, 'backup created');
      this.prune();

      return { filename, path: finalPath, sizeBytes, sha256, integrity, createdAt };
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  /**
   * Opens the backup, decrypts it and runs SQLite's own integrity check.
   * Returns counts so a restore test can compare against the live database.
   */
  verify(filePath: string): VerifyResult {
    const started = Date.now();
    const tmp = `${filePath}.verify-${started}.db`;

    try {
      const key = this.config.backups.key;
      if (!key) throw new AppError(400, 'backups_disabled', 'No BACKUP_ENCRYPTION_KEY configured');

      const plain = gunzipSync(this.decrypt(readFileSync(filePath), key));
      writeFileSync(tmp, plain, { mode: 0o600 });

      const integrity = this.integrityCheck(tmp);
      const probe = new Database(tmp, { readonly: true });
      let tables = 0;
      try {
        tables = (
          probe
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .get() as { count: number }
        ).count;
      } finally {
        probe.close();
      }

      return {
        ok: integrity === 'ok',
        integrity,
        tables,
        sizeBytes: statSync(filePath).size,
        createdAt: null,
        error: integrity === 'ok' ? null : integrity,
      };
    } catch (error) {
      return {
        ok: false,
        integrity: 'unreadable',
        tables: 0,
        sizeBytes: existsSync(filePath) ? statSync(filePath).size : 0,
        createdAt: null,
        error: error instanceof Error ? error.message : 'could not read the backup',
      };
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /**
   * Restores a backup over the live database file.
   *
   * The caller (CLI) is responsible for refusing while the server runs. A copy
   * of the current database is kept first, so a wrong file is recoverable, and
   * migrations run afterwards in case the backup predates the current schema.
   */
  restore(filePath: string): { restoredFrom: string; safetyCopy: string; tables: number } {
    const key = this.config.backups.key;
    if (!key) throw new AppError(400, 'backups_disabled', 'No BACKUP_ENCRYPTION_KEY configured');

    const plain = gunzipSync(this.decrypt(readFileSync(filePath), key));
    const staging = `${filePath}.restore-${Date.now()}.db`;
    writeFileSync(staging, plain, { mode: 0o600 });

    const integrity = this.integrityCheck(staging);
    if (integrity !== 'ok') {
      rmSync(staging, { force: true });
      throw new AppError(400, 'backup_integrity', `Refusing to restore: ${integrity}`);
    }

    const live = resolve(this.config.dbPath);
    const safetyCopy = `${live}.before-restore-${Date.now()}`;

    this.db.close();
    copyFileSync(live, safetyCopy);
    rmSync(`${live}-wal`, { force: true });
    rmSync(`${live}-shm`, { force: true });
    copyFileSync(staging, live);
    rmSync(staging, { force: true });

    // Reopen through the normal path and bring the schema up to date.
    const restored = new Database(live);
    restored.pragma('journal_mode = WAL');
    restoreMigrations: {
      migrate(restored);
      break restoreMigrations;
    }

    const tables = (
      restored
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .get() as { count: number }
    ).count;

    restored.close();

    return { restoredFrom: basename(filePath), safetyCopy, tables };
  }

  /** Removes backups beyond the retention window. Only our own filenames. */
  prune(): number {
    const dir = resolve(this.config.backups.dir);
    if (!existsSync(dir)) return 0;

    const entries = readdirSync(dir)
      .filter((name) => FILENAME_PATTERN.test(name))
      .map((name) => ({ name, created: this.timestampOf(name) }))
      .filter((entry): entry is { name: string; created: number } => entry.created !== null)
      .sort((a, b) => b.created - a.created);

    const keep = new Set<string>();
    const days = new Set<string>();
    const weeks = new Set<string>();
    let weekly = 0;

    for (const entry of entries) {
      const date = new Date(entry.created);
      const day = date.toISOString().slice(0, 10);
      const week = `${date.getUTCFullYear()}-W${Math.floor(entry.created / (7 * 86_400_000))}`;

      if (days.size < this.config.backups.keepDaily && !days.has(day)) {
        days.add(day);
        keep.add(entry.name);
        continue;
      }

      if (weekly < this.config.backups.keepWeekly && !weeks.has(week)) {
        weeks.add(week);
        weekly += 1;
        keep.add(entry.name);
      }
    }

    let removed = 0;
    for (const entry of entries) {
      if (keep.has(entry.name)) continue;

      const path = join(dir, entry.name);
      rmSync(path, { force: true });

      const row = this.db.prepare('SELECT id FROM backups WHERE filename = ?').get(entry.name) as
        | { id: number }
        | undefined;
      if (row) deleteBackupRow(this.db, row.id);

      removed += 1;
    }

    if (removed > 0) this.logger.info({ removed }, 'pruned old backups');
    return removed;
  }

  list(): BackupRow[] {
    return listBackups(this.db);
  }

  latest(): BackupRow | null {
    return latestBackup(this.db);
  }

  /** Deletes one backup file and its row. Never leaves the backup directory. */
  remove(id: number, path: string): void {
    const resolved = resolve(path);
    if (!resolved.startsWith(`${resolve(this.config.backups.dir)}/`)) {
      throw AppError.badRequest('Backup path is outside the backup directory', 'bad_backup_path');
    }

    rmSync(resolved, { force: true });
    deleteBackupRow(this.db, id);
  }

  scheduleNotify(handler: (error: unknown) => void): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.create('scheduled').catch(handler);
    }, this.config.backups.scheduleHours * 3_600_000);

    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ----------------------------------------------------------------- private

  private async snapshot(destination: string): Promise<void> {
    // better-sqlite3 exposes SQLite's online backup API; fall back to
    // VACUUM INTO (also an online, consistent snapshot) on older builds.
    const backup = (this.db as unknown as { backup?: (path: string) => Promise<unknown> }).backup;

    if (typeof backup === 'function') {
      await backup.call(this.db, destination);
      return;
    }

    this.db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  }

  private integrityCheck(path: string): string {
    const probe = new Database(path, { readonly: true });
    try {
      const row = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
      return row?.integrity_check ?? 'unknown';
    } finally {
      probe.close();
    }
  }

  private encrypt(payload: Buffer, key: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(file: Buffer, key: Buffer): Buffer {
    if (file.length < MAGIC.length + 28 || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Not a CaptureHost backup file');
    }

    const iv = file.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = file.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const ciphertext = file.subarray(MAGIC.length + 28);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // Wrong key or a tampered file: GCM tells us, and we say so plainly.
      throw new Error('Could not decrypt the backup (wrong BACKUP_ENCRYPTION_KEY or corrupted file)');
    }
  }

  private timestampOf(filename: string): number | null {
    const match = /^capturehost-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.chbk$/.exec(filename);
    if (!match) return null;

    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }
}

export { FILENAME_PATTERN };

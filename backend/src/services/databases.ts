import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Docker from 'dockerode';
import { Client as PgClientClass } from 'pg';
import type { AppConfig } from '../config.js';
import { decryptString, encryptString } from '../crypto/secretbox.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import {
  createDatabase,
  deleteDatabaseRow,
  getDatabase,
  getDatabaseByName,
  linkFor,
  linkProject,
  listDatabases,
  listLinksForDatabase,
  setDatabaseStatus,
  setLastBackupAt,
  unlinkProject,
  type DatabaseRow,
} from '../db/databases.repo.js';
import { getProject } from '../db/projects.repo.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';
import {
  DATABASE_CONTAINER_PORT,
  DATABASE_OWNER,
  assertDatabaseName,
  assertDatabaseVersion,
  buildDatabaseCreateOptions,
  databaseContainerName,
  databaseImage,
  databaseVolumeName,
} from './databasePolicy.js';
import type { NotificationService } from './notifications.js';

/**
 * Postgres databases owned by CaptureHost.
 *
 * The service is the only place that talks to a database container: it builds the
 * payload through `databasePolicy`, keeps SQLite and Docker in step, and never
 * holds a plaintext password outside the lifetime of a single call. `pg` is used
 * as an ordinary client over the container network — no `EXEC`, no published port
 * required, no shell inside anything.
 */

const PASSWORD_CONTEXT = 'database.password';
const BACKUP_CONTEXT = 'database.backup';
const SNAPSHOT_PATTERN = /^db-\d+-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.dump\.chbk$/;

export interface DatabaseDto {
  id: number;
  name: string;
  engine: 'postgres';
  version: string;
  status: string;
  containerName: string;
  volume: string;
  port: number | null;
  published: boolean;
  dbName: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastBackupAt: number | null;
  lastError: string | null;
  internalHost: string;
  internalPort: number;
  internalUrl: string;
  links: Array<{ projectId: number; projectName: string; envKey: string }>;
}

export interface DatabaseBackupDto {
  fileName: string;
  createdAt: number;
  sizeBytes: number;
}

export interface TableInfo {
  schema: string;
  name: string;
  rows: number | null;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

/** The tiny slice of `pg` this service needs, so tests can fake it. */
export interface PgLike {
  query(input: { text: string; values?: unknown[] } | string): Promise<{ rows: Array<Record<string, unknown>>; fields?: Array<{ name: string }>; rowCount: number | null }>;
  end(): Promise<void>;
}
export type PgFactory = (options: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionTimeoutMillis: number;
}) => PgLike;

export interface DatabaseServiceDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  client: Docker;
  notifications?: Pick<NotificationService, 'notify'>;
  pgFactory?: PgFactory;
  now?: () => number;
  /** Labels added to every container this service creates (integration tests). */
  extraLabels?: Record<string, string>;
}

export class DatabaseService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly client: Docker;
  private readonly notifications?: Pick<NotificationService, 'notify'>;
  private readonly pgFactory: PgFactory;
  private readonly now: () => number;
  private readonly extraLabels: Record<string, string>;

  constructor(deps: DatabaseServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;
    this.client = deps.client;
    this.notifications = deps.notifications;
    this.pgFactory = deps.pgFactory ?? defaultPgFactory;
    this.now = deps.now ?? (() => Date.now());
    this.extraLabels = deps.extraLabels ?? {};
  }

  // ------------------------------------------------------------------- read

  list(): DatabaseDto[] {
    return listDatabases(this.db).map((row) => this.toDto(row));
  }

  get(id: number): DatabaseDto {
    const row = getDatabase(this.db, id);
    if (!row) throw AppError.notFound('Database not found');
    return this.toDto(row);
  }

  /** The password, for the places that must have it (create, backups, connections). */
  private password(row: DatabaseRow): string {
    return decryptString(row.password_encrypted, this.config.encryptionKey, PASSWORD_CONTEXT);
  }

  // -------------------------------------------------------------- lifecycle

  async create(input: {
    name: string;
    version: string;
    published: boolean;
    memoryLimitMb?: number | null;
    cpuLimit?: number | null;
    ctx: { actor: string; ip?: string | null };
  }): Promise<{ database: DatabaseDto; password: string }> {
    const name = assertDatabaseName(input.name);
    const version = assertDatabaseVersion(input.version);
    if (getDatabaseByName(this.db, name)) {
      throw AppError.conflict('A database with that name already exists', 'database_name_taken');
    }

    const password = randomBytes(24).toString('base64url').slice(0, 32);
    const now = this.now();
    const pending = `pending-${randomUUID()}`;

    // Insert first to obtain the id, because both the volume and the container
    // name are derived from it and must match the policy exactly.
    const id = createDatabase(this.db, {
      name,
      version,
      containerName: pending,
      volume: pending,
      port: null,
      dbName: name.replace(/-/g, '_'),
      username: DATABASE_OWNER,
      passwordEncrypted: encryptString(password, this.config.encryptionKey, PASSWORD_CONTEXT),
      now,
    });

    const containerName = databaseContainerName(id);
    const volume = databaseVolumeName(id);
    this.db
      .prepare('UPDATE databases SET container_name = ?, volume = ?, db_name = ? WHERE id = ?')
      .run(containerName, volume, name.replace(/-/g, '_'), id);

    const publishedPort = input.published ? this.nextFreePublishedPort() : null;

    try {
      const built = buildDatabaseCreateOptions({
        id,
        password,
        version,
        dbName: name.replace(/-/g, '_'),
        username: DATABASE_OWNER,
        publishedPort,
        memoryLimitMb: input.memoryLimitMb ?? null,
        cpuLimit: input.cpuLimit ?? null,
        limits: this.limits(),
        extraLabels: this.extraLabels,
      });

      const container = await this.client.createContainer(built.options as never);
      await container.start();

      // initdb takes a few seconds; "running" only means the process exists.
      await this.waitUntilReady(getDatabase(this.db, id)!, 45_000);

      this.db
        .prepare('UPDATE databases SET port = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(publishedPort, 'running', this.now(), id);

      writeAudit(this.db, {
        action: 'database.create',
        actor: input.ctx.actor,
        target: name,
        detail: `postgres ${version}${publishedPort ? `, published on 127.0.0.1:${publishedPort}` : ', internal only'}`,
        ip: input.ctx.ip ?? null,
      });

      const row = getDatabase(this.db, id)!;
      return { database: this.toDto(row), password };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'could not start the container';
      setDatabaseStatus(this.db, id, 'failed', { error: message.slice(0, 300), now: this.now() });
      this.logger.error({ err: message, id }, 'database container failed to start');
      throw AppError.badRequest(`The database container could not start: ${message}`, 'database_create_failed');
    }
  }

  async start(id: number, ctx: { actor: string; ip?: string | null }): Promise<DatabaseDto> {
    const row = this.requireDatabase(id);
    await this.client.getContainer(row.container_name).start();
    setDatabaseStatus(this.db, id, 'running', { error: null, now: this.now() });
    this.audit('database.start', row.name, ctx);
    return this.toDto(this.requireDatabase(id));
  }

  async stop(id: number, ctx: { actor: string; ip?: string | null }): Promise<DatabaseDto> {
    const row = this.requireDatabase(id);
    await this.client.getContainer(row.container_name).stop({ t: 10 }).catch(() => undefined);
    setDatabaseStatus(this.db, id, 'stopped', { now: this.now() });
    this.audit('database.stop', row.name, ctx);
    return this.toDto(this.requireDatabase(id));
  }

  async restart(id: number, ctx: { actor: string; ip?: string | null }): Promise<DatabaseDto> {
    const row = this.requireDatabase(id);
    await this.client.getContainer(row.container_name).restart({ t: 10 });
    setDatabaseStatus(this.db, id, 'running', { error: null, now: this.now() });
    this.audit('database.restart', row.name, ctx);
    return this.toDto(this.requireDatabase(id));
  }

  /**
   * Deletes the row and the container. The **volume is left behind**, because the
   * socket proxy runs with VOLUMES=0: this process cannot delete volumes, and that
   * is the point — it also cannot delete yours. The response names the volume so
   * the operator can remove it deliberately.
   */
  async remove(
    id: number,
    confirmName: string,
    ctx: { actor: string; ip?: string | null },
  ): Promise<{ removed: boolean; orphanedVolume: string; removeCommand: string }> {
    const row = this.requireDatabase(id);
    if (confirmName !== row.name) {
      throw AppError.badRequest('Type the database name exactly to confirm', 'confirm_mismatch');
    }
    if (row.status === 'running') {
      throw AppError.conflict('Stop the database before deleting it', 'database_running');
    }
    const links = listLinksForDatabase(this.db, id);
    if (links.length > 0) {
      throw AppError.conflict(
        `Unlink it from ${links.map((link) => link.project_name).join(', ')} first`,
        'database_linked',
      );
    }

    await this.client.getContainer(row.container_name).remove({ force: false }).catch((error: unknown) => {
      // A container that is already gone is not a failure to delete the record.
      this.logger.warn({ err: error instanceof Error ? error.message : error, id }, 'container remove failed');
    });

    deleteDatabaseRow(this.db, id);
    this.audit('database.delete', row.name, ctx, `volume ${row.volume} left behind`);

    return {
      removed: true,
      orphanedVolume: row.volume,
      removeCommand: `docker volume rm ${row.volume}`,
    };
  }

  // ------------------------------------------------------------------ links

  /**
   * Links a database to a project by writing `DATABASE_URL` into its encrypted env
   * vars. Nothing is injected into a running container: the project has to be
   * redeployed, and the caller is told so.
   */
  link(
    projectId: number,
    databaseId: number,
    envKey: string,
    ctx: { actor: string; ip?: string | null },
  ): { ok: true; redeployRequired: true; envKey: string } {
    const project = getProject(this.db, projectId);
    if (!project) throw AppError.notFound('Project not found');
    const row = this.requireDatabase(databaseId);

    const url = this.internalUrl(row);
    this.db
      .prepare(
        `INSERT INTO env_vars (project_id, key, value_encrypted, created_at)
         VALUES (@projectId, @key, @value, @now)
         ON CONFLICT(project_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted`,
      )
      .run({
        projectId,
        key: envKey,
        value: encryptString(url, this.config.encryptionKey, `project.env.${envKey}`),
        now: this.now(),
      });

    linkProject(this.db, { projectId, databaseId, envKey, now: this.now() });
    this.audit('database.link', row.name, ctx, `project ${project.name}, env ${envKey}`);

    return { ok: true, redeployRequired: true, envKey };
  }

  unlink(projectId: number, databaseId: number, ctx: { actor: string; ip?: string | null }): { ok: true } {
    const row = this.requireDatabase(databaseId);
    const link = linkFor(this.db, projectId, databaseId);
    if (!link) throw AppError.notFound('That database is not linked to this project');

    // Only remove the env var if it still holds the URL we wrote.
    const existing = this.db
      .prepare('SELECT value_encrypted FROM env_vars WHERE project_id = ? AND key = ?')
      .get(projectId, link.env_key) as { value_encrypted: string } | undefined;
    if (existing) {
      try {
        const value = decryptString(existing.value_encrypted, this.config.encryptionKey, `project.env.${link.env_key}`);
        if (value === this.internalUrl(row)) {
          this.db.prepare('DELETE FROM env_vars WHERE project_id = ? AND key = ?').run(projectId, link.env_key);
        }
      } catch {
        // A value we cannot read is not ours to delete.
      }
    }

    unlinkProject(this.db, projectId, databaseId);
    this.audit('database.unlink', row.name, ctx, `project ${projectId}, env ${link.env_key}`);
    return { ok: true };
  }

  // ------------------------------------------------------------- connection

  internalUrl(row: DatabaseRow): string {
    const password = encodeURIComponent(this.password(row));
    const user = encodeURIComponent(row.username);
    return `postgres://${user}:${password}@${row.container_name}:${DATABASE_CONTAINER_PORT}/${row.db_name}`;
  }

  private toDto(row: DatabaseRow): DatabaseDto {
    return {
      id: row.id,
      name: row.name,
      engine: 'postgres',
      version: row.version,
      status: row.status,
      containerName: row.container_name,
      volume: row.volume,
      port: row.port,
      published: row.port !== null,
      dbName: row.db_name,
      username: row.username,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastBackupAt: row.last_backup_at,
      lastError: row.last_error,
      internalHost: row.container_name,
      internalPort: DATABASE_CONTAINER_PORT,
      // The DTO deliberately carries the URL *without* the password.
      internalUrl: `postgres://${row.username}@${row.container_name}:${DATABASE_CONTAINER_PORT}/${row.db_name}`,
      links: listLinksForDatabase(this.db, row.id).map((link) => ({
        projectId: link.project_id,
        projectName: link.project_name ?? `project ${link.project_id}`,
        envKey: link.env_key,
      })),
    };
  }

  // ------------------------------------------------------------------- pg IO

  /** Where the backend itself connects: the container's address on the app network. */
  private async endpoint(row: DatabaseRow): Promise<{ host: string; port: number }> {
    const info = (await this.client.getContainer(row.container_name).inspect()) as {
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    };
    const ip = info.NetworkSettings?.Networks?.[this.config.deploy.network]?.IPAddress;
    if (!ip) {
      throw AppError.badRequest(
        'The database container has no address yet — is it running?',
        'database_unreachable',
      );
    }
    return { host: ip, port: DATABASE_CONTAINER_PORT };
  }

  private async withClient<T>(row: DatabaseRow, run: (client: PgLike) => Promise<T>): Promise<T> {
    const { host, port } = await this.endpoint(row);
    const client = this.pgFactory({
      host,
      port,
      user: row.username,
      password: this.password(row),
      database: row.db_name,
      connectionTimeoutMillis: 5_000,
    });
    try {
      return await run(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'database error';
      throw AppError.badRequest(`Database said: ${message.slice(0, 300)}`, 'database_error');
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async metrics(id: number): Promise<{ sizeBytes: number; connections: number; version: string | null }> {
    const row = this.requireDatabase(id);
    return this.withClient(row, async (client) => {
      const size = await client.query({ text: 'SELECT pg_database_size(current_database()) AS size' });
      const connections = await client.query({
        text: 'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
      });
      const version = await client.query({ text: 'SHOW server_version' });
      return {
        sizeBytes: Number(size.rows[0]?.size ?? 0),
        connections: Number(connections.rows[0]?.count ?? 0),
        version: asString(version.rows[0]?.server_version),
      };
    });
  }

  async tables(id: number): Promise<TableInfo[]> {
    const row = this.requireDatabase(id);
    return this.withClient(row, async (client) => {
      const tables = await client.query({
        text: `SELECT table_schema, table_name
                 FROM information_schema.tables
                WHERE table_type = 'BASE TABLE'
                  AND table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_schema, table_name`,
      });
      const columns = await client.query({
        text: `SELECT table_schema, table_name, column_name, data_type, is_nullable
                 FROM information_schema.columns
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY ordinal_position`,
      });

      const byTable = new Map<string, TableInfo['columns']>();
      for (const column of columns.rows) {
        const key = `${column.table_schema}.${column.table_name}`;
        const list = byTable.get(key) ?? [];
        list.push({
          name: String(column.column_name),
          type: String(column.data_type),
          nullable: column.is_nullable === 'YES',
        });
        byTable.set(key, list);
      }

      return tables.rows.map((table) => ({
        schema: String(table.table_schema),
        name: String(table.table_name),
        rows: null,
        columns: byTable.get(`${table.table_schema}.${table.table_name}`) ?? [],
      }));
    });
  }

  async rows(id: number, schema: string, table: string, page: number): Promise<QueryResult> {
    const row = this.requireDatabase(id);
    const limit = this.config.databases.queryRowLimit;
    const offset = (Math.max(1, page) - 1) * limit;

    // Identifiers cannot be parameterised, so they are allowlisted against the
    // catalogue and quoted. Anything not in information_schema is refused.
    const known = await this.tables(id);
    const match = known.find((entry) => entry.schema === schema && entry.name === table);
    if (!match) throw AppError.notFound('No such table in this database');

    const sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${limit} OFFSET ${offset}`;
    return this.withClient(row, async (client) => {
      const started = this.now();
      const result = await client.query({ text: sql });
      return {
        columns: (result.fields ?? []).map((field) => field.name),
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
        durationMs: this.now() - started,
        truncated: (result.rows.length ?? 0) === limit,
      };
    });
  }

  /**
   * Runs one statement (or a batch) typed by the operator.
   *
   * Admin-only by routing, with a hard statement timeout, a row cap and an audit
   * row that keeps 200 characters of the statement — never the results.
   */
  async query(id: number, sql: string, ctx: { actor: string; ip?: string | null }): Promise<QueryResult> {
    const row = this.requireDatabase(id);
    const text = sql.trim();
    if (text === '') throw AppError.badRequest('The statement is empty', 'empty_query');
    if (text.length > 20_000) throw AppError.badRequest('Statement is too long', 'query_too_long');

    const result = await this.withClient(row, async (client) => {
      await client.query({ text: `SET statement_timeout = ${this.config.databases.queryTimeoutMs}` });
      const started = this.now();
      const response = await client.query({ text });
      const rows = response.rows ?? [];
      const limit = this.config.databases.queryRowLimit;
      return {
        columns: (response.fields ?? []).map((field) => field.name),
        rows: rows.slice(0, limit),
        rowCount: response.rowCount ?? rows.length,
        durationMs: this.now() - started,
        truncated: rows.length > limit,
      };
    });

    this.audit('database.query', row.name, ctx, text.replace(/\s+/g, ' ').slice(0, 200));
    return result;
  }

  // --------------------------------------------------------------- backups

  backupDir(id: number): string {
    return join(this.config.databases.dir, String(id));
  }

  listBackups(id: number): DatabaseBackupDto[] {
    this.requireDatabase(id);
    const dir = this.backupDir(id);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((file) => SNAPSHOT_PATTERN.test(file))
      .map((file) => {
        const stats = statSync(join(dir, file));
        return { fileName: file, createdAt: stats.mtimeMs, sizeBytes: stats.size };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * `pg_dump -Fc` in a short-lived helper container on the same network.
   *
   * The archive leaves through the container's stdout (the attach stream), so there
   * is no `exec`, no `docker cp`, no shared host path and no published port. The
   * password travels in the helper's environment only, and the helper is removed in
   * a `finally`.
   */
  async createBackup(id: number, ctx: { actor: string; ip?: string | null }): Promise<DatabaseBackupDto> {
    const row = this.requireDatabase(id);
    if (row.status !== 'running') {
      throw AppError.conflict('Start the database before taking a backup', 'database_stopped');
    }

    const started = this.now();
    const helperName = `${row.container_name}-dump-${started}`;
    let helper: Docker.Container | null = null;

    try {
      helper = await this.client.createContainer({
        name: helperName,
        Image: databaseImage(row.version),
        // Bypass docker-entrypoint.sh so nothing but the archive reaches stdout,
        // and give -h/-p explicitly: the default is a unix socket that does not
        // exist in the helper. The database is reached by container name on the
        // same network — no published port, no host path.
        Entrypoint: ['pg_dump'],
        Cmd: [
          '-Fc',
          '-h', row.container_name,
          '-p', String(DATABASE_CONTAINER_PORT),
          '-U', row.username,
          '-d', row.db_name,
        ],
        Env: [`PGPASSWORD=${this.password(row)}`, 'PGCONNECT_TIMEOUT=10'],
        Labels: {
          'capturehost.managed': 'true',
          'capturehost.database.backup': String(id),
          ...this.extraLabels,
        },
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          NetworkMode: this.config.deploy.network,
          Privileged: false,
          CapDrop: ['ALL'],
          Devices: [],
          Binds: [],
          AutoRemove: false,
          PidsLimit: 64,
        },
      } as never);

      const stream = (await helper.attach({ stream: true, stdout: true, stderr: true })) as NodeJS.ReadableStream;
      const collected = collectFrames(stream);
      await helper.start();
      const { stdout, stderr } = await collected;
      const exit = (await helper.wait()) as { StatusCode: number };

      if (exit.StatusCode !== 0 || stdout.length === 0) {
        throw new Error(stderr.toString('utf8').trim().slice(0, 300) || `pg_dump exited ${exit.StatusCode}`);
      }

      const dir = this.backupDir(id);
      mkdirSync(dir, { recursive: true });
      const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
      const fileName = `db-${id}-${stamp}.dump.chbk`;
      const encrypted = encryptString(stdout.toString('base64'), this.config.encryptionKey, BACKUP_CONTEXT);
      writeFileSync(join(dir, fileName), encrypted, { mode: 0o600 });

      setLastBackupAt(this.db, id, started);
      this.pruneBackups(id);
      this.audit('database.backup', row.name, ctx, `${fileName} (${stdout.length} bytes)`);

      return { fileName, createdAt: started, sizeBytes: stdout.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'backup failed';
      this.logger.error({ err: message, id }, 'database backup failed');
      await this.notifications?.notify({
        event: 'database.backup_failed',
        severity: 'error',
        title: `Backup failed: ${row.name}`,
        body: message,
        dedupeKey: `database.backup_failed:${id}`,
      });
      throw AppError.badRequest(`Backup failed: ${message}`, 'database_backup_failed');
    } finally {
      await helper?.remove({ force: true, v: false }).catch(() => undefined);
    }
  }

  deleteBackup(id: number, fileName: string): { ok: true } {
    const row = this.requireDatabase(id);
    if (!SNAPSHOT_PATTERN.test(fileName)) throw AppError.badRequest('Unknown backup file', 'invalid_backup');
    const path = join(this.backupDir(id), fileName);
    if (!existsSync(path)) throw AppError.notFound('Backup not found');
    unlinkSync(path);
    this.audit('database.backup.delete', row.name, { actor: 'admin' }, fileName);
    return { ok: true };
  }

  /**
   * Restores a snapshot into a **new** database. The source is never touched: the
   * new container is created exactly like any other, then `pg_restore` is fed the
   * decrypted archive through its stdin.
   */
  async restoreBackup(
    id: number,
    fileName: string,
    newName: string,
    ctx: { actor: string; ip?: string | null },
  ): Promise<{ database: DatabaseDto; password: string }> {
    const source = this.requireDatabase(id);
    if (!SNAPSHOT_PATTERN.test(fileName)) throw AppError.badRequest('Unknown backup file', 'invalid_backup');

    const path = join(this.backupDir(id), fileName);
    if (!existsSync(path)) throw AppError.notFound('Backup not found');

    const created = await this.create({
      name: newName,
      version: source.version,
      published: false,
      ctx,
    });

    const target = this.requireDatabase(created.database.id);
    // The restore helper connects over TCP; wait for the server, not the process.
    await this.waitUntilReady(target, 90_000);
    const dump = Buffer.from(
      decryptString(readFileSync(path, 'utf8'), this.config.encryptionKey, BACKUP_CONTEXT),
      'base64',
    );

    let helper: Docker.Container | null = null;
    try {
      helper = await this.client.createContainer({
        name: `${target.container_name}-restore-${this.now()}`,
        Image: databaseImage(target.version),
        Entrypoint: ['pg_restore'],
        Cmd: [
          '-h', target.container_name,
          '-p', String(DATABASE_CONTAINER_PORT),
          '-U', target.username,
          '-d', target.db_name,
          '--no-owner',
          '--no-privileges',
          '--exit-on-error',
          '/tmp/dump.archive',
        ],
        Env: [`PGPASSWORD=${this.password(target)}`, 'PGCONNECT_TIMEOUT=10'],
        Labels: {
          'capturehost.managed': 'true',
          'capturehost.database.restore': String(target.id),
          ...this.extraLabels,
        },
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          NetworkMode: this.config.deploy.network,
          Privileged: false,
          CapDrop: ['ALL'],
          Devices: [],
          Binds: [],
          AutoRemove: false,
          PidsLimit: 64,
        },
      } as never);

      // The archive goes in as a file (a one-file tar) rather than on stdin:
      // docker's stdio attach does not reliably deliver EOF for a hijacked
      // connection, and pg_restore then blocks forever reading a socket that will
      // never close. COPY-into-container is a plain CONTAINERS call.
      const archive = await helper.attach({ stream: true, stdout: true, stderr: true });
      const collected = collectFrames(archive as NodeJS.ReadableStream);
      await helper.putArchive(makeTarFile('dump.archive', dump), { path: '/tmp' });
      await helper.start();

      const { stderr } = await collected;
      const exit = (await helper.wait()) as { StatusCode: number };
      if (exit.StatusCode !== 0) {
        throw new Error(stderr.toString('utf8').trim().slice(0, 300) || `pg_restore exited ${exit.StatusCode}`);
      }

      this.audit('database.restore', source.name, ctx, `${fileName} -> ${target.name}`);
      return { database: this.get(target.id), password: created.password };
    } finally {
      await helper?.remove({ force: true, v: false }).catch(() => undefined);
    }
  }

  /** Keeps the newest `backupKeep` snapshots per database. */
  private pruneBackups(id: number): void {
    const keep = this.config.databases.backupKeep;
    for (const backup of this.listBackups(id).slice(keep)) {
      unlinkSync(join(this.backupDir(id), backup.fileName));
    }
  }

  /** Scheduled pass: back up every running database, then nag about stale ones. */
  async runScheduledBackups(): Promise<void> {
    for (const row of listDatabases(this.db)) {
      if (row.status !== 'running') continue;
      try {
        await this.createBackup(row.id, { actor: 'system' });
      } catch (error) {
        this.logger.warn({ err: error instanceof Error ? error.message : error }, 'scheduled backup failed');
      }
    }
    await this.checkStaleBackups();
  }

  async checkStaleBackups(): Promise<void> {
    const maxAge = this.config.databases.backupMaxAgeHours * 3_600_000;
    const now = this.now();

    for (const row of listDatabases(this.db)) {
      if (row.status !== 'running') continue;
      const last = row.last_backup_at ?? row.created_at;
      const age = now - last;
      if (age <= maxAge) continue;

      await this.notifications?.notify({
        event: 'database.backup_stale',
        severity: 'warning',
        title: `No recent backup: ${row.name}`,
        body: `The last backup of "${row.name}" is more than ${this.config.databases.backupMaxAgeHours} hours old.`,
        dedupeKey: `database.backup_stale:${row.id}`,
      });
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Polls a fresh container until it answers a query.
   *
   * `docker start` returns as soon as the process exists, which is several seconds
   * before initdb has finished and the socket accepts connections.
   */
  private async waitUntilReady(row: DatabaseRow, timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs;
    let lastError = 'no connection yet';

    while (this.now() < deadline) {
      try {
        await this.withClient(row, (client) => client.query({ text: 'select 1' }));
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    throw AppError.badRequest(
      `The database did not accept connections within ${Math.round(timeoutMs / 1000)}s: ${lastError.slice(0, 200)}`,
      'database_not_ready',
    );
  }

  private requireDatabase(id: number): DatabaseRow {
    const row = getDatabase(this.db, id);
    if (!row) throw AppError.notFound('Database not found');
    return row;
  }

  private limits() {
    return {
      memoryDefaultMb: this.config.deploy.memoryDefaultMb,
      memoryMaxMb: this.config.deploy.memoryMaxMb,
      cpuDefault: this.config.deploy.cpuDefault,
      cpuMax: this.config.deploy.cpuMax,
      pidsLimit: this.config.deploy.pidsLimit,
      network: this.config.deploy.network,
      portRangeStart: this.config.deploy.portRangeStart,
      portRangeEnd: this.config.deploy.portRangeEnd,
    };
  }

  private nextFreePublishedPort(): number {
    const used = new Set(
      (this.db.prepare('SELECT port FROM databases WHERE port IS NOT NULL').all() as { port: number }[]).map(
        (row) => row.port,
      ),
    );
    const projectPorts = new Set(
      (this.db.prepare('SELECT host_port FROM projects WHERE host_port IS NOT NULL').all() as {
        host_port: number;
      }[]).map((row) => row.host_port),
    );

    for (let port = this.config.deploy.portRangeStart; port <= this.config.deploy.portRangeEnd; port += 1) {
      if (!used.has(port) && !projectPorts.has(port)) return port;
    }
    throw AppError.badRequest('No free port in the published range', 'no_free_port');
  }

  private audit(action: string, target: string, ctx: { actor: string; ip?: string | null }, detail?: string): void {
    writeAudit(this.db, {
      action,
      actor: ctx.actor,
      target,
      detail: detail ?? null,
      ip: ctx.ip ?? null,
    });
  }
}

// ---------------------------------------------------------------- utilities

function defaultPgFactory(options: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionTimeoutMillis: number;
}): PgLike {
  // Constructed here, not at module load, so tests never open a socket.
  const client = new PgClientClass({ ...options, application_name: 'capturehost', statement_timeout: 10_000 });
  void client.connect().catch(() => undefined);
  return client as unknown as PgLike;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `schema.table` identifiers are quoted; they were allowlisted before this point. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A one-file tar, for `putArchive`.
 *
 * tar is a 512-byte header, the file padded to a 512-byte boundary, then two zero
 * blocks. Writing it by hand avoids a dependency for the single thing Docker's
 * copy-into-container API accepts.
 */
export function makeTarFile(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, 'utf8');
  header.write('0000644\0', 100, 'utf8');
  header.write('0000000\0', 108, 'utf8');
  header.write('0000000\0', 116, 'utf8');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'utf8');
  header.write('        ', 148, 'utf8'); // checksum field counts as spaces
  header.write('0', 156, 'utf8'); // regular file
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  const trailer = Buffer.alloc(1024);
  return Buffer.concat([header, data, padding, trailer]);
}

/** Same framing as `collectFrames`, for a complete buffer (container logs). */
export function demuxBuffer(buffer: Buffer): string {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    out.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  // Not multiplexed (a TTY container) — hand back the raw bytes.
  return (out.length > 0 ? Buffer.concat(out) : buffer).toString('utf8');
}

/**
 * Reads Docker's multiplexed stdout/stderr framing.
 *
 * Eight-byte header per frame: stream id (1 = stdout, 2 = stderr), three zero
 * bytes, then a big-endian uint32 length, then the payload.
 */
export function collectFrames(stream: NodeJS.ReadableStream): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let buffer = Buffer.alloc(0);

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const length = buffer.readUInt32BE(4);
        if (buffer.length < 8 + length) break;
        const payload = buffer.subarray(8, 8 + length);
        const channel = buffer[0];
        (channel === 2 ? stderr : stdout).push(Buffer.from(payload));
        buffer = buffer.subarray(8 + length);
      }
    });
    stream.on('end', () => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    stream.on('error', reject);
  });
}

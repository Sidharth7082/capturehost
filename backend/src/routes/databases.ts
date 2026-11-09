import { createReadStream, createWriteStream, mkdirSync, readFileSync, unlinkSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import { DATABASE_ALLOWED_VERSIONS } from '../services/databasePolicy.js';
import { detectDumpFormat, type DatabaseService, type DumpFormat } from '../services/databases.js';
import { AppError } from '../utils/errors.js';
import { resolveClientIp } from '../utils/clientIp.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';

/**
 * Database routes.
 *
 * Everything here is session-required; writes and the SQL editor also need the
 * CSRF token, which the global hook enforces. The SQL editor is the sharpest tool
 * in the app — it runs what the operator types as the database owner — so it has
 * its own rate budget, a statement timeout enforced by the service, and an audit
 * row per statement.
 */

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const CreateSchema = z.object({
  name: z.string().min(3).max(30),
  version: z.enum(DATABASE_ALLOWED_VERSIONS),
  published: z.boolean().optional().default(false),
  memoryLimitMb: z.number().int().min(64).max(4096).optional(),
  cpuLimit: z.number().min(0.1).max(4).optional(),
});

const ConfirmSchema = z.object({ confirm: z.string().min(1).max(64) });
const LinkSchema = z.object({
  projectId: z.number().int().positive(),
  envKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,40}$/, 'Use an env var name like DATABASE_URL')
    .optional()
    .default('DATABASE_URL'),
});
const QuerySchema = z.object({ sql: z.string().min(1).max(20_000) });
const TableParam = z.object({
  schema: z.string().min(1).max(63),
  table: z.string().min(1).max(63),
});
const PageQuery = z.object({ page: z.coerce.number().int().min(1).max(10_000).optional().default(1) });
const BackupFileParam = z.object({ file: z.string().regex(/^db-\d+-[\w-]+\.dump\.chbk$/) });
const RestoreSchema = z.object({ name: z.string().min(3).max(30) });
const CloneSchema = z.object({ name: z.string().min(3).max(30) });
const ImportQuery = z.object({
  name: z.string().min(3).max(30),
  version: z.enum(DATABASE_ALLOWED_VERSIONS),
});
const ImportExistingQuery = z.object({ confirm: z.string().min(1).max(64) });
const LogsQuery = z.object({ tail: z.coerce.number().int().min(1).max(2000).optional().default(200) });

export interface DatabaseRoutesDeps {
  db: Db;
  databases: DatabaseService;
  /** Writes, backups and the SQL editor. */
  limiter: SessionRateLimiter;
  trustedAddresses: readonly string[];
  /** Docker logs, already demultiplexed by the caller. */
  readContainerLogs: (containerName: string, tail: number) => Promise<string>;
  /** Where an uploaded dump is streamed before it is imported, and its size cap. */
  uploadDir: string;
  maxUploadBytes: number;
}

export function registerDatabaseRoutes(app: AppInstance, deps: DatabaseRoutesDeps): void {
  const clientIp = (request: {
    socket: { remoteAddress?: string };
    headers: Record<string, string | string[] | undefined>;
  }): string =>
    resolveClientIp({
      peer: request.socket.remoteAddress,
      cfConnectingIp: request.headers['cf-connecting-ip'],
      trustedAddresses: deps.trustedAddresses,
    });

  const ctx = (request: {
    auth?: { username: string };
    socket: { remoteAddress?: string };
    headers: Record<string, string | string[] | undefined>;
  }) => ({ actor: request.auth?.username ?? 'admin', ip: clientIp(request) });

  const consume = (sessionId: string, action: string): void => {
    const result = deps.limiter.consume(sessionId);
    if (result.allowed) return;
    throw new AppError(429, 'rate_limited', 'Too many database actions. Wait a moment.', {
      'retry-after': String(result.retryAfterSeconds),
    });
  };

  // -------------------------------------------------------------------- list
  app.get('/api/databases', async (request) => {
    requireAuth(request);
    return { databases: deps.databases.list() };
  });

  // ------------------------------------------------------------------ create
  app.post('/api/databases', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.create');

    const body = CreateSchema.parse(request.body);
    const created = await deps.databases.create({
      name: body.name,
      version: body.version,
      published: body.published,
      memoryLimitMb: body.memoryLimitMb ?? null,
      cpuLimit: body.cpuLimit ?? null,
      ctx: ctx(request),
    });

    // The password is returned exactly once, here, and never again.
    return { database: created.database, password: created.password };
  });

  // --------------------------------------------------------------------- one
  app.get('/api/databases/:id', async (request) => {
    requireAuth(request);
    const { id } = IdParam.parse(request.params);
    return { database: deps.databases.get(id) };
  });

  // --------------------------------------------------------------- lifecycle
  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/databases/:id/${action}`, async (request) => {
      const session = requireAuth(request);
      consume(session.sessionId, `database.${action}`);
      const { id } = IdParam.parse(request.params);
      const database = await deps.databases[action](id, ctx(request));
      return { database };
    });
  }

  app.delete('/api/databases/:id', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.delete');
    const { id } = IdParam.parse(request.params);
    const body = ConfirmSchema.parse(request.body ?? {});
    return deps.databases.remove(id, body.confirm, ctx(request));
  });

  // ----------------------------------------------------------------- metrics
  app.get('/api/databases/:id/metrics', async (request) => {
    requireAuth(request);
    const { id } = IdParam.parse(request.params);
    return deps.databases.metrics(id);
  });

  // -------------------------------------------------------------------- logs
  app.get('/api/databases/:id/logs', async (request) => {
    requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { tail } = LogsQuery.parse(request.query ?? {});
    const database = deps.databases.get(id);
    const text = await deps.readContainerLogs(database.containerName, tail);
    return { containerName: database.containerName, logs: text };
  });

  // ---------------------------------------------------------- table browser
  app.get('/api/databases/:id/tables', async (request) => {
    requireAuth(request);
    const { id } = IdParam.parse(request.params);
    return { tables: await deps.databases.tables(id) };
  });

  app.get('/api/databases/:id/tables/:schema/:table/rows', async (request) => {
    requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { schema, table } = TableParam.parse(request.params);
    const { page } = PageQuery.parse(request.query ?? {});
    return deps.databases.rows(id, schema, table, page);
  });

  // ------------------------------------------------------------- SQL editor
  app.post('/api/databases/:id/query', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.query');
    const { id } = IdParam.parse(request.params);
    const body = QuerySchema.parse(request.body);
    return deps.databases.query(id, body.sql, ctx(request));
  });

  // ------------------------------------------------------------------- links
  app.post('/api/databases/:id/link', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.link');
    const { id } = IdParam.parse(request.params);
    const body = LinkSchema.parse(request.body);
    return deps.databases.link(body.projectId, id, body.envKey, ctx(request));
  });

  app.delete('/api/databases/:id/link/:projectId', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.unlink');
    const { id } = IdParam.parse(request.params);
    const { projectId } = z.object({ projectId: z.coerce.number().int().positive() }).parse(request.params);
    return deps.databases.unlink(projectId, id, ctx(request));
  });

  // ------------------------------------------------------------------ clone
  app.post('/api/databases/:id/clone', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.clone');
    const { id } = IdParam.parse(request.params);
    const body = CloneSchema.parse(request.body);
    return deps.databases.cloneDatabase(id, body.name, ctx(request));
  });

  // ----------------------------------------------------------------- uploads
  /**
   * A dump is streamed to disk by the content-type parser below, never buffered in
   * memory: a 200 MB file must not become 200 MB of RSS. The handler reads only
   * the first bytes to classify the format, then hands the path to the service and
   * deletes the file in a `finally` — a failed import must not leave dumps behind.
   */
  const takeUpload = async (request: { body?: unknown }): Promise<{ filePath: string; fileName: string; bytes: number }> => {
    const uploaded = request.body as { filePath?: string; fileName?: string; bytes?: number } | undefined;
    if (!uploaded?.filePath) {
      throw AppError.badRequest('Send the dump as the raw request body (application/octet-stream)', 'no_upload');
    }
    return { filePath: uploaded.filePath, fileName: uploaded.fileName ?? 'upload', bytes: uploaded.bytes ?? 0 };
  };

  app.post('/api/databases/import', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.import');

    const query = ImportQuery.parse(request.query ?? {});
    const upload = await takeUpload(request);

    try {
      const prepared = await prepareUpload(upload.filePath, deps.maxUploadBytes);
      return await deps.databases.importDump({
        name: query.name,
        version: query.version,
        filePath: prepared.filePath,
        fileName: basename(upload.fileName),
        format: prepared.format,
        ctx: ctx(request),
      });
    } finally {
      cleanupUpload(upload.filePath);
    }
  });

  /**
   * Import into an EXISTING database.
   *
   * Only allowed when it has no tables: the rest of this app never overwrites data
   * in place, and an import that merged into a live schema is exactly the accident
   * this rule exists to prevent. The name has to be typed as well.
   */
  app.post('/api/databases/:id/import', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.import');
    const { id } = IdParam.parse(request.params);
    const query = ImportExistingQuery.parse(request.query ?? {});
    const database = deps.databases.get(id);

    if (query.confirm !== database.name) {
      throw AppError.badRequest('Type the database name exactly to confirm', 'confirm_mismatch');
    }
    if (database.status !== 'running') {
      throw AppError.conflict('Start the database before importing into it', 'database_stopped');
    }

    const tables = await deps.databases.userTableCount(id);
    if (tables > 0) {
      throw AppError.conflict(
        `That database already has ${tables} table(s). Import into a new database instead — nothing here overwrites data in place.`,
        'database_not_empty',
      );
    }

    const upload = await takeUpload(request);
    try {
      const prepared = await prepareUpload(upload.filePath, deps.maxUploadBytes);
      const data = readFileSync(prepared.filePath);
      if (data.length === 0) throw AppError.badRequest('That file is empty', 'import_empty');

      const restored = await deps.databases.importIntoExisting(id, data, prepared.format, {
        actor: session.username,
        ip: clientIp(request),
        fileName: basename(upload.fileName),
        bytes: data.length,
      });
      return { database: restored };
    } finally {
      cleanupUpload(upload.filePath);
    }
  });

  // ----------------------------------------------------------------- backups
  app.get('/api/databases/:id/backups', async (request) => {
    requireAuth(request);
    const { id } = IdParam.parse(request.params);
    return { backups: deps.databases.listBackups(id) };
  });

  app.post('/api/databases/:id/backups', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.backup');
    const { id } = IdParam.parse(request.params);
    const backup = await deps.databases.createBackup(id, ctx(request));
    return { backup };
  });

  app.delete('/api/databases/:id/backups/:file', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.backup.delete');
    const { id } = IdParam.parse(request.params);
    const { file } = BackupFileParam.parse(request.params);
    return deps.databases.deleteBackup(id, file);
  });

  app.post('/api/databases/:id/backups/:file/restore', async (request) => {
    const session = requireAuth(request);
    consume(session.sessionId, 'database.restore');
    const { id } = IdParam.parse(request.params);
    const { file } = BackupFileParam.parse(request.params);
    const body = RestoreSchema.parse(request.body);
    return deps.databases.restoreBackup(id, file, body.name, ctx(request));
  });
}

/**
 * Registers the raw upload parser.
 *
 * `application/octet-stream` is used by nothing else in this API, so widening the
 * body limit for that one content type widens nothing that takes JSON. The stream
 * is written to disk as it arrives and aborted the moment it exceeds the cap.
 */
export function registerUploadParser(
  app: AppInstance,
  options: { uploadDir: string; maxUploadBytes: number },
): void {
  mkdirSync(options.uploadDir, { recursive: true });

  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: options.maxUploadBytes },
    (request, payload, done) => {
      const filePath = join(options.uploadDir, `${randomUUID()}.upload`);
      const sink = createWriteStream(filePath);
      let bytes = 0;
      let aborted = false;

      const header = String(request.headers['x-upload-name'] ?? 'upload');
      const fileName = basename(header).slice(0, 120);

      payload.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > options.maxUploadBytes && !aborted) {
          aborted = true;
          payload.destroy();
          sink.destroy();
          cleanupUpload(filePath);
          done(new AppError(413, 'upload_too_large', `Dump is larger than ${options.maxUploadBytes} bytes`, {}), undefined);
        }
      });

      payload.on('error', (error: Error) => {
        sink.destroy();
        cleanupUpload(filePath);
        done(error, undefined);
      });

      sink.on('error', (error: Error) => {
        cleanupUpload(filePath);
        done(error, undefined);
      });

      sink.on('finish', () => {
        if (!aborted) done(null, { filePath, fileName, bytes });
      });

      payload.pipe(sink);
    },
  );
}

/**
 * Normalises an upload: gunzips when needed (with a decompressed-size cap, so a zip
 * bomb is a 413 and not a full disk), then classifies the format by content.
 */
async function prepareUpload(filePath: string, maxBytes: number): Promise<{ filePath: string; format: DumpFormat }> {
  const magic = readMagic(filePath, 4);
  if (magic.length >= 2 && magic[0] === 0x1f && magic[1] === 0x8b) {
    const rawPath = `${filePath}.raw`;
    let written = 0;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > maxBytes) {
          callback(new AppError(413, 'upload_too_large', 'The decompressed dump is larger than allowed', {}));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(createReadStream(filePath), createGunzip(), counter, createWriteStream(rawPath));
    const format = detectDumpFormat(readHead(rawPath, 4096));
    return { filePath: rawPath, format };
  }

  return { filePath, format: detectDumpFormat(readHead(filePath, 4096)) };
}

function readMagic(filePath: string, length: number): Buffer {
  return readHead(filePath, length);
}

function readHead(filePath: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Removes the uploaded file and any decompressed sibling. */
function cleanupUpload(filePath: string): void {
  for (const path of [filePath, `${filePath}.raw`]) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* nothing sensible to do */
      }
    }
  }
}

import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import { DATABASE_ALLOWED_VERSIONS } from '../services/databasePolicy.js';
import type { DatabaseService } from '../services/databases.js';
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
const LogsQuery = z.object({ tail: z.coerce.number().int().min(1).max(2000).optional().default(200) });

export interface DatabaseRoutesDeps {
  db: Db;
  databases: DatabaseService;
  /** Writes, backups and the SQL editor. */
  limiter: SessionRateLimiter;
  trustedAddresses: readonly string[];
  /** Docker logs, already demultiplexed by the caller. */
  readContainerLogs: (containerName: string, tail: number) => Promise<string>;
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

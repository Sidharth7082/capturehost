import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import { getAdmin } from '../db/auth.repo.js';
import type { Db } from '../db/connection.js';
import { getBackup } from '../db/ops.repo.js';
import { listNotifications } from '../db/ops.repo.js';
import { verifyPassword } from '../crypto/password.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import type { BackupService } from '../services/backup.js';
import type { DoctorService } from '../services/doctor.js';
import type { NotificationService } from '../services/notifications.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';

/** Backups, notifications and the doctor endpoint. */

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const DownloadSchema = z.object({ password: z.string().min(1).max(512) });
const ReadSchema = z.object({ ids: z.union([z.literal('all'), z.array(z.coerce.number().int().positive()).max(200)]) });

export interface OpsRoutesDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  backups: BackupService;
  notifications: NotificationService;
  doctor: DoctorService;
  /** Downloading a backup needs the password again; 3 attempts per minute. */
  downloadLimiter: SessionRateLimiter;
}

export function registerOpsRoutes(app: AppInstance, deps: OpsRoutesDeps): void {
  // --------------------------------------------------------------- backups
  app.get('/api/backups', async (request) => {
    requireAuth(request);

    const latest = deps.backups.latest();
    return {
      enabled: deps.config.backups.key !== null,
      scheduleHours: deps.config.backups.scheduleHours,
      keepDaily: deps.config.backups.keepDaily,
      keepWeekly: deps.config.backups.keepWeekly,
      latestAgeHours: latest ? (Date.now() - latest.created_at) / 3_600_000 : null,
      backups: deps.backups.list().map((backup) => ({
        id: backup.id,
        filename: backup.filename,
        sizeBytes: backup.size_bytes,
        kind: backup.kind,
        integrity: backup.integrity,
        createdAt: backup.created_at,
      })),
    };
  });

  app.post('/api/backups', async (request) => {
    const session = requireAuth(request);

    const result = await deps.backups.create('manual');

    writeAudit(deps.db, {
      action: 'backup.create',
      actor: session.username,
      target: result.filename,
      detail: `${result.sizeBytes} bytes, integrity ${result.integrity}`,
      ip: request.ip,
    });

    return { backup: { filename: result.filename, sizeBytes: result.sizeBytes, sha256: result.sha256 } };
  });

  app.delete('/api/backups/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);

    const backup = getBackup(deps.db, id);
    if (!backup) throw AppError.notFound('Backup not found');

    deps.backups.remove(id, backup.path);

    writeAudit(deps.db, {
      action: 'backup.delete',
      actor: session.username,
      target: backup.filename,
      ip: request.ip,
    });

    return { ok: true };
  });

  /**
   * Download: password re-entry + per-session rate limit. The file is streamed
   * as an attachment; the key never leaves the server and the path is resolved
   * inside the backup directory by the service.
   */
  app.post('/api/backups/:id/download', async (request, reply) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const body = DownloadSchema.parse(request.body);

    const rate = deps.downloadLimiter.consume(session.sessionId);
    if (!rate.allowed) {
      throw new AppError(429, 'rate_limited', 'Too many download attempts. Wait a minute.', {
        'retry-after': String(rate.retryAfterSeconds),
      });
    }

    const backup = getBackup(deps.db, id);
    if (!backup) throw AppError.notFound('Backup not found');

    const admin = getAdmin(deps.db);
    if (!admin) throw AppError.notFound('Admin not found');

    const ok = await verifyPassword(admin.password_hash, body.password);
    if (!ok) {
      writeAudit(deps.db, {
        action: 'backup.download_denied',
        actor: session.username,
        target: backup.filename,
        detail: 'wrong password',
        ip: request.ip,
        success: false,
      });
      throw new AppError(401, 'invalid_password', 'Password is incorrect');
    }

    writeAudit(deps.db, {
      action: 'backup.download',
      actor: session.username,
      target: backup.filename,
      ip: request.ip,
    });

    const file = readFileSync(backup.path);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${backup.filename}"`)
      .send(file);
  });

  // --------------------------------------------------------- notifications
  app.get('/api/notifications', async (request) => {
    requireAuth(request);

    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);

    return {
      unread: deps.notifications.unread(),
      notifications: listNotifications(deps.db, query.limit).map((row) => ({
        id: row.id,
        event: row.event,
        severity: row.severity,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
        readAt: row.read_at,
      })),
    };
  });

  app.post('/api/notifications/read', async (request) => {
    requireAuth(request);
    const body = ReadSchema.parse(request.body);
    const changed = deps.notifications.markRead(body.ids);
    return { ok: true, changed };
  });

  app.get('/api/notifications/channel', async (request) => {
    requireAuth(request);
    const status = deps.notifications.channelStatus();
    return { ...status, cooldownMinutes: Math.round(deps.config.notify.cooldownMs / 60_000) };
  });

  app.post('/api/notifications/test', async (request) => {
    const session = requireAuth(request);

    const result = await deps.notifications.sendTest();

    writeAudit(deps.db, {
      action: 'notify.test',
      actor: session.username,
      target: 'channel',
      detail: result.ok ? 'delivered' : (result.error ?? 'failed'),
      ip: request.ip,
      success: result.ok,
    });

    if (!result.ok) throw AppError.badRequest(result.error ?? 'Test notification failed', 'notify_failed');
    return { ok: true };
  });

  // ----------------------------------------------------------------- doctor
  app.get('/api/doctor', async (request) => {
    requireAuth(request);
    return deps.doctor.run();
  });
}

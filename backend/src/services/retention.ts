import type { AppConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import type { Logger } from '../logger.js';

/**
 * Retention: drop old rows, and only old rows.
 *
 * Every delete is bounded by a timestamp and a table this app owns. Nothing
 * here touches Docker images — image retention belongs to the deploy pipeline
 * (keep N per project) and to project deletion, both of which filter by our own
 * `capturehost/*` tags and `capturehost.managed` label.
 */

export interface RetentionReport {
  auditLog: number;
  deploymentLogs: number;
  webhookDeliveries: number;
  loginAttempts: number;
  notifications: number;
  expiredSessions: number;
  ranAt: number;
}

const DAY = 86_400_000;

export class RetentionService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: { db: Db; config: AppConfig; logger: Logger }) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;
  }

  run(now = Date.now()): RetentionReport {
    const cfg = this.config.retention;

    const auditLog = this.db
      .prepare('DELETE FROM audit_log WHERE ts < ?')
      .run(now - cfg.auditDays * DAY).changes;

    // The build log is the big column: clear it, keep the deployment row.
    const deploymentLogs = this.db
      .prepare(
        `UPDATE deployments
         SET log = NULL
         WHERE log IS NOT NULL AND created_at < ? AND status NOT IN ('queued','cloning','building','starting','health-check')`,
      )
      .run(now - cfg.deployLogDays * DAY).changes;

    const webhookDeliveries = this.db
      .prepare('DELETE FROM webhook_deliveries WHERE received_at < ?')
      .run(now - cfg.deliveriesDays * DAY).changes;

    const loginAttempts = this.db
      .prepare('DELETE FROM login_attempts WHERE last_at < ?')
      .run(now - cfg.attemptsDays * DAY).changes;

    const notifications = this.db
      .prepare('DELETE FROM notifications WHERE created_at < ? AND read_at IS NOT NULL')
      .run(now - cfg.notificationsDays * DAY).changes;

    const expiredSessions = this.db
      .prepare('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?')
      .run(now, now).changes;

    const report: RetentionReport = {
      auditLog,
      deploymentLogs,
      webhookDeliveries,
      loginAttempts,
      notifications,
      expiredSessions,
      ranAt: now,
    };

    const total = Object.entries(report)
      .filter(([key]) => key !== 'ranAt')
      .reduce((sum, [, value]) => sum + Number(value), 0);

    if (total > 0) this.logger.info(report, 'retention pass removed rows');

    return report;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      try {
        this.run();
      } catch (error) {
        this.logger.error({ err: error }, 'retention pass failed');
      }
    }, this.config.retention.intervalMs);

    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

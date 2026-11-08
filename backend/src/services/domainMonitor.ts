import type { Db } from '../db/connection.js';
import { getDomain, listSyncTargets, setConsecutiveFailures } from '../db/domains.repo.js';
import type { Logger } from '../logger.js';
import type { CaddyService } from './caddy.js';
import type { NotificationService } from './notifications.js';

/**
 * Domain health monitoring.
 *
 * A single failed check is noise (Caddy may be mid-reload). Three in a row is a
 * real outage, and a recovery is worth knowing about because it closes the loop
 * on the earlier alert. Counters live in SQLite so a restart does not reset
 * them, and the alerts reuse the notification service's dedupe + cooldown.
 */

export interface DomainMonitorDeps {
  db: Db;
  caddy: Pick<CaddyService, 'checkDomain'>;
  notifications: Pick<NotificationService, 'notify'>;
  logger: Logger;
  threshold?: number;
}

export interface DomainCheckOutcome {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
  consecutiveFailures: number;
  alerted: 'failure' | 'recovered' | null;
}

export class DomainMonitor {
  private readonly db: Db;
  private readonly caddy: DomainMonitorDeps['caddy'];
  private readonly notifications: DomainMonitorDeps['notifications'];
  private readonly logger: Logger;
  private readonly threshold: number;

  constructor(deps: DomainMonitorDeps) {
    this.db = deps.db;
    this.caddy = deps.caddy;
    this.notifications = deps.notifications;
    this.logger = deps.logger;
    this.threshold = deps.threshold ?? 3;
  }

  /** Checks one domain, updates the counter and raises alerts at the edges. */
  async checkOne(domainId: number): Promise<DomainCheckOutcome> {
    const domain = getDomain(this.db, domainId);
    if (!domain) throw new Error('Domain not found');

    const previous = domain.consecutive_failures ?? 0;
    const result = await this.caddy.checkDomain(domainId);

    const consecutiveFailures = result.ok ? 0 : previous + 1;
    setConsecutiveFailures(this.db, domainId, consecutiveFailures, Date.now());

    let alerted: DomainCheckOutcome['alerted'] = null;

    if (!result.ok && consecutiveFailures === this.threshold) {
      alerted = 'failure';
      await this.notifications.notify({
        event: 'domain.check_failed',
        severity: 'error',
        title: `${domain.hostname} is not answering`,
        body:
          `Failed ${consecutiveFailures} checks in a row (${result.error ?? `HTTP ${result.status}`}). ` +
          'Check the project container and the Caddy route.',
        dedupeKey: `domain.failed:${domain.hostname}`,
        meta: { domainId, hostname: domain.hostname },
      });
      this.logger.warn({ domainId, hostname: domain.hostname }, 'domain failing repeatedly');
    } else if (result.ok && previous >= this.threshold) {
      alerted = 'recovered';
      await this.notifications.notify({
        event: 'domain.recovered',
        severity: 'info',
        title: `${domain.hostname} is answering again`,
        body: `Recovered after ${previous} failed check${previous === 1 ? '' : 's'} (HTTP ${result.status}).`,
        dedupeKey: `domain.recovered:${domain.hostname}`,
        meta: { domainId, hostname: domain.hostname },
      });
    }

    return {
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
      consecutiveFailures,
      alerted,
    };
  }

  /**
   * Scheduled sweep: every enabled domain whose project has a live container.
   * Runs from the same 5-minute health watcher as the disk/Caddy checks.
   */
  async checkAll(): Promise<number> {
    const targets = listSyncTargets(this.db).filter(
      (target) => target.container_id !== null && target.host_port !== null,
    );

    let alerts = 0;

    for (const target of targets) {
      try {
        const outcome = await this.checkOne(target.id);
        if (outcome.alerted) alerts += 1;
      } catch (error) {
        this.logger.warn({ err: error, domainId: target.id }, 'domain check failed to run');
      }
    }

    return alerts;
  }
}

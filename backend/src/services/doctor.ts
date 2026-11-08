import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import si from 'systeminformation';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import { getAdmin } from '../db/auth.repo.js';
import { latestBackup } from '../db/ops.repo.js';
import type { Logger } from '../logger.js';
import type { CaddyService } from './caddy.js';
import type { DockerService } from './docker.js';

const run = promisify(execFile);

/**
 * The "doctor": a list of assertions about how this instance is configured.
 *
 * Every check answers pass / warn / fail with a concrete fix, and none of them
 * ever prints a secret value — only whether something is set and whether it
 * looks like a placeholder.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ranAt: number;
  summary: { pass: number; warn: number; fail: number; skip: number };
  checks: DoctorCheck[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const PLACEHOLDER_VALUES = new Set(['', 'change-me', 'changeme', 'example', 'test', 'secret', 'dev']);

function looksLikePlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  return PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
}

/** Reads the proxy's answer without ever exposing its internals. */
async function proxyAnswer(baseUrl: string, path: string): Promise<number | null> {
  try {
    const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(2000) });
    return response.status;
  } catch {
    return null;
  }
}

export class DoctorService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly caddy: CaddyService;
  private readonly docker: DockerService;

  constructor(deps: { db: Db; config: AppConfig; logger: Logger; caddy: CaddyService; docker: DockerService }) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;
    this.caddy = deps.caddy;
    this.docker = deps.docker;
  }

  async run(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];

    const push = (check: DoctorCheck): void => {
      checks.push(check);
    };

    // ---------------------------------------------------------------- admin
    const admin = getAdmin(this.db);
    push(
      admin
        ? { id: 'admin-exists', title: 'Admin account exists', status: 'pass', detail: `username "${admin.username}"` }
        : {
            id: 'admin-exists',
            title: 'Admin account exists',
            status: 'fail',
            detail: 'no admin row in the database',
            fix: 'npm run setup:admin',
          },
    );

    push(
      admin?.totp_enabled === 1
        ? { id: '2fa-enabled', title: 'Two-factor authentication enabled', status: 'pass', detail: 'TOTP is on' }
        : {
            id: '2fa-enabled',
            title: 'Two-factor authentication enabled',
            status: 'warn',
            detail: '2FA is off for the only account',
            fix: 'Settings → Security → Enable 2FA (5 minutes, with an authenticator app)',
          },
    );

    // -------------------------------------------------------------- session
    const wantsHttps = this.config.caddy.mode === 'public';
    push(
      this.config.session.secure === wantsHttps
        ? {
            id: 'cookie-secure',
            title: 'Session cookie Secure flag matches the mode',
            status: 'pass',
            detail: `SESSION_COOKIE_SECURE=${this.config.session.secure} in ${this.config.caddy.mode} mode`,
          }
        : {
            id: 'cookie-secure',
            title: 'Session cookie Secure flag matches the mode',
            status: wantsHttps ? 'fail' : 'warn',
            detail: wantsHttps
              ? 'public mode serves HTTPS but the cookie is not Secure'
              : 'cookie is Secure but this mode serves plain HTTP (the browser will drop it)',
            fix: `Set SESSION_COOKIE_SECURE=${wantsHttps} in .env and restart`,
          },
    );

    const looseTrust = this.config.trustProxyAddresses.filter((address) => !isLoopback(address));
    push(
      !this.config.trustProxy
        ? {
            id: 'trust-proxy',
            title: 'Proxy trust is explicit',
            status: 'pass',
            detail: 'X-Forwarded-For is ignored (no proxy in front)',
          }
        : looseTrust.length === 0
          ? {
              id: 'trust-proxy',
              title: 'Proxy trust is explicit',
              status: 'pass',
              detail: `trusted addresses: ${this.config.trustProxyAddresses.join(', ')}`,
            }
          : {
              id: 'trust-proxy',
              title: 'Proxy trust is explicit',
              status: 'fail',
              detail: `non-loopback addresses trusted: ${looseTrust.join(', ')}`,
              fix: 'TRUST_PROXY_ADDRESSES should only contain 127.0.0.1 / ::1',
            },
    );

    // ------------------------------------------------------------ listeners
    push(
      isLoopback(this.config.host) &&
        isLoopback(this.config.caddy.appsListen.host) &&
        isLoopback(this.config.caddy.dashboardListen.host)
        ? {
            id: 'listeners-loopback',
            title: 'All listeners are on loopback',
            status: 'pass',
            detail: `${this.config.host}:${this.config.port}, ${this.config.caddy.appsListen.host}:${this.config.caddy.appsListen.port}, ${this.config.caddy.dashboardListen.host}:${this.config.caddy.dashboardListen.port}`,
          }
        : {
            id: 'listeners-loopback',
            title: 'All listeners are on loopback',
            status: 'fail',
            detail: 'a listener is bound to a non-loopback address',
            fix: 'Set HOST=127.0.0.1, CADDY_APPS_LISTEN and CADDY_DASHBOARD_LISTEN to 127.0.0.1:<port>',
          },
    );

    // --------------------------------------------------------- docker socket
    let socketFds = 0;
    try {
      for (const fd of readdirSync('/proc/self/fd')) {
        try {
          // readlink, never read: reading a pipe descriptor blocks forever.
          if (readlinkSync(`/proc/self/fd/${fd}`).includes('docker.sock')) socketFds += 1;
        } catch {
          /* fd closed between readdir and readlink */
        }
      }
    } catch {
      /* not Linux: the check is skipped below */
    }

    push(
      socketFds === 0
        ? {
            id: 'no-docker-socket',
            title: 'Backend has no Docker socket',
            status: 'pass',
            detail: 'no docker.sock file descriptor in this process',
          }
        : {
            id: 'no-docker-socket',
            title: 'Backend has no Docker socket',
            status: 'fail',
            detail: `${socketFds} open descriptor(s) on docker.sock`,
            fix: 'Point DOCKER_HOST_URL at the socket proxy and restart the backend',
          },
    );

    // ------------------------------------------------------------ proxy flags
    const execStatus = await proxyAnswer(this.config.docker.hostUrl, '/exec');
    const systemStatus = await proxyAnswer(this.config.docker.hostUrl, '/system/info');
    const containersStatus = await proxyAnswer(this.config.docker.hostUrl, '/containers/json');

    if (containersStatus === null) {
      push({
        id: 'proxy-flags',
        title: 'Socket proxy enforces the minimal flag set',
        status: 'fail',
        detail: 'the proxy is not reachable',
        fix: 'docker compose -f docker-compose.yml up -d',
      });
    } else {
      const blocked = (status: number | null): boolean => status === 403 || status === 404;
      const ok = blocked(execStatus) && blocked(systemStatus) && containersStatus === 200;

      push({
        id: 'proxy-flags',
        title: 'Socket proxy enforces the minimal flag set',
        status: ok ? 'pass' : 'fail',
        detail: ok
          ? `containers/exec/system answered ${containersStatus}/${execStatus}/${systemStatus} (exec and system refused)`
          : `containers/exec/system answered ${containersStatus}/${execStatus}/${systemStatus} — exec or system is exposed`,
        ...(ok ? {} : { fix: 'Set EXEC=0 and SYSTEM=0 in docker-compose.yml and recreate the proxy' }),
      });
    }

    {
      const adminHost = new URL(this.config.caddy.adminUrl).hostname;
      push(
        isLoopback(adminHost)
          ? {
              id: 'caddy-admin-loopback',
              title: "Caddy's admin API is loopback only",
              status: 'pass',
              detail: this.config.caddy.adminUrl,
            }
          : {
              id: 'caddy-admin-loopback',
              title: "Caddy's admin API is loopback only",
              status: 'fail',
              detail: `admin URL host is ${adminHost}`,
              fix: 'CADDY_ADMIN_URL must be http://127.0.0.1:2019',
            },
      );
    }

    // ---------------------------------------------------------------- caddy
    const caddyStatus = await this.caddy.status();
    push(
      !caddyStatus.reachable
        ? {
            id: 'caddy-reachable',
            title: 'Caddy is reachable with no drift',
            status: 'fail',
            detail: caddyStatus.error ?? 'admin API not reachable',
            fix: 'systemctl start caddy, or run it from deploy/caddy/Caddyfile',
          }
        : caddyStatus.drift
          ? {
              id: 'caddy-reachable',
              title: 'Caddy is reachable with no drift',
              status: 'warn',
              detail: 'Caddy is running but its routes differ from SQLite (sync will repair)',
              fix: 'POST /api/caddy/status after a sync, or restart the backend to reconcile',
            }
          : {
              id: 'caddy-reachable',
              title: 'Caddy is reachable with no drift',
              status: 'pass',
              detail: `caddy ${caddyStatus.version ?? 'unknown'}, ${caddyStatus.managedRoutes} managed route(s)`,
            },
    );

    // -------------------------------------------------------------- secrets
    const envText = this.environmentText();
    const appKeyOk = /^APP_ENCRYPTION_KEY=\S{20,}/m.test(envText) && !/APP_ENCRYPTION_KEY=(change|example)/i.test(envText);
    push(
      appKeyOk
        ? { id: 'app-key', title: 'APP_ENCRYPTION_KEY looks real', status: 'pass', detail: 'set, not a placeholder' }
        : {
            id: 'app-key',
            title: 'APP_ENCRYPTION_KEY looks real',
            status: 'fail',
            detail: 'missing or still a placeholder',
            fix: 'openssl rand -base64 32 → APP_ENCRYPTION_KEY in .env (this makes existing secrets unreadable)',
          },
    );

    push(
      this.config.backups.key
        ? { id: 'backup-key', title: 'BACKUP_ENCRYPTION_KEY is set', status: 'pass', detail: 'backups can be encrypted' }
        : {
            id: 'backup-key',
            title: 'BACKUP_ENCRYPTION_KEY is set',
            status: 'fail',
            detail: 'no backup key: creating a backup fails',
            fix: 'openssl rand -base64 32 → BACKUP_ENCRYPTION_KEY in .env, and store it off this machine',
          },
    );

    // ---------------------------------------------------------------- backup
    const backup = latestBackup(this.db);
    if (!backup) {
      push({
        id: 'backup-age',
        title: 'A recent backup exists',
        status: 'fail',
        detail: 'no backups recorded',
        fix: 'Backups → Back up now',
      });
    } else {
      const ageHours = (Date.now() - backup.created_at) / 3_600_000;
      push({
        id: 'backup-age',
        title: 'A recent backup exists',
        status: ageHours <= this.config.backups.maxAgeHours ? 'pass' : 'warn',
        detail: `last backup ${ageHours.toFixed(1)}h ago (${backup.filename})`,
        ...(ageHours <= this.config.backups.maxAgeHours
          ? {}
          : { fix: `Check BACKUP_SCHEDULE_HOURS (limit is ${this.config.backups.maxAgeHours}h) and backup logs` }),
      });
    }

    // ----------------------------------------------------------------- disk
    try {
      // systeminformation can block on an odd mount (stale NFS, slow FUSE), so
      // the check races a timeout and degrades to "skipped" instead of hanging
      // the whole report.
      const [fs] = await Promise.race([
        si.fsSize(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      const used = fs?.use ?? 0;
      push({
        id: 'disk-space',
        title: 'Disk space',
        status: used >= this.config.notify.diskThresholdPct ? 'fail' : used >= 80 ? 'warn' : 'pass',
        detail: `${used.toFixed(0)}% used on ${fs?.mount ?? '/'} (threshold ${this.config.notify.diskThresholdPct}%)`,
        ...(used >= 80 ? { fix: 'docker image prune of our own images, clear deployments/, prune old backups' } : {}),
      });
    } catch {
      push({ id: 'disk-space', title: 'Disk space', status: 'skip', detail: 'filesystem stats unavailable' });
    }

    // ------------------------------------------------------------ file modes
    {
      const envPath = join(REPO_ROOT, 'backend', '.env');
      try {
        const mode = statSync(envPath).mode & 0o777;
        push({
          id: 'env-permissions',
          title: '.env is not group/world readable',
          status: (mode & 0o077) === 0 ? 'pass' : 'fail',
          detail: `mode ${mode.toString(8)}`,
          ...((mode & 0o077) === 0 ? {} : { fix: `chmod 600 ${envPath}` }),
        });
      } catch {
        push({
          id: 'env-permissions',
          title: '.env is not group/world readable',
          status: 'warn',
          detail: 'no backend/.env found (production uses real env vars)',
        });
      }
    }

    // --------------------------------------------------------------- git tree
    {
      const tracked = await this.gitTrackedSecrets();
      push(
        tracked.length === 0
          ? {
              id: 'secrets-not-tracked',
              title: '.env and data/ are not tracked by git',
              status: 'pass',
              detail: 'git ls-files reports nothing for them',
            }
          : {
              id: 'secrets-not-tracked',
              title: '.env and data/ are not tracked by git',
              status: 'fail',
              detail: `tracked: ${tracked.join(', ')}`,
              fix: 'git rm --cached <path> and add it to .gitignore',
            },
      );
    }

    // ------------------------------------------------------------- defaults
    const defaults: string[] = [];
    if (this.config.caddy.mode === 'local') defaults.push('CADDY_MODE=local (dev)');
    if (this.config.caddy.allowedBaseDomains.join(',') === 'localhost') defaults.push('ALLOWED_BASE_DOMAINS=localhost');
    if (!this.config.notify.webhookUrl) defaults.push('no NOTIFY_WEBHOOK_URL');

    push(
      defaults.length === 0
        ? { id: 'defaults', title: 'No development defaults in use', status: 'pass', detail: 'all set explicitly' }
        : {
            id: 'defaults',
            title: 'No development defaults in use',
            status: 'warn',
            detail: defaults.join('; '),
            fix: 'Intended for a laptop; change these before exposing anything publicly',
          },
    );

    const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const check of checks) summary[check.status] += 1;

    return { ranAt: Date.now(), summary, checks };
  }

  // ----------------------------------------------------------------- private

  private environmentText(): string {
    try {
      return readFileSync(join(REPO_ROOT, 'backend', '.env'), 'utf8');
    } catch {
      return '';
    }
  }

  private async gitTrackedSecrets(): Promise<string[]> {
    try {
      const { stdout } = await run(
        'git',
        ['-C', REPO_ROOT, 'ls-files', '--', 'backend/.env', 'backend/data', 'frontend/.env'],
        { timeout: 3000 },
      );
      return stdout.split('\n').filter((line) => line.trim() !== '');
    } catch {
      return [];
    }
  }
}

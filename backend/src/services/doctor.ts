import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { diskUsageFor } from './diskMonitor.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import { getAdmin } from '../db/auth.repo.js';
import { getIntegration } from '../db/integrations.repo.js';
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


/**
 * Reads the tunnel's ingress rules, if the operator has written them.
 *
 * `cloudflared` config lives outside the repo and does not exist on a machine
 * that has not set the tunnel up yet, so a missing file is a skip, never a
 * failure. Only the two fields that matter are parsed: hostname and service.
 */
export function readCloudflaredIngress(
  paths: readonly string[] = [
    process.env.CLOUDFLARED_CONFIG ?? '',
    // `cloudflared service install` / the system package use the first path;
    // a hand-run tunnel uses the second.
    '/etc/cloudflared/config.yml',
    join(homedir(), '.cloudflared', 'config.yml'),
  ].filter(Boolean),
): { hostname: string; service: string }[] | null {
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    const entries: { hostname: string; service: string }[] = [];
    let pending: string | null = null;
    for (const line of text.split('\n')) {
      const host = /^\s*-?\s*hostname:\s*(\S+)/.exec(line);
      if (host?.[1]) {
        pending = host[1].replace(/^["']|["']$/g, '');
        continue;
      }
      const service = /^\s*service:\s*(\S+)/.exec(line);
      if (service?.[1] && pending !== null) {
        entries.push({ hostname: pending, service: service[1].replace(/^["']|["']$/g, '') });
        pending = null;
      }
    }
    return entries;
  }
  return null;
}

function servicePort(service: string): number {
  try {
    const url = new URL(service);
    if (url.port !== '') return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

function dialPort(dial: string): number {
  const separator = dial.lastIndexOf(':');
  return separator === -1 ? 0 : Number(dial.slice(separator + 1));
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

    // ------------------------------------------------------- public exposure
    // The apps listener is fed to a tunnel by the operator, so anything it
    // proxies to is reachable from the internet. A route pointing at one of our
    // own listeners would publish the dashboard, the API, Vite, Caddy's admin API
    // or the Docker socket proxy — the five ports listed here.
    const PRIVATE_PORTS: Record<number, string> = {
      8787: 'backend API',
      8090: 'dashboard (served build)',
      5173: 'Vite dev server',
      2019: "Caddy's admin API",
      2375: 'Docker socket proxy',
    };

    // The dashboard listener is allowed to proxy to the backend — that is what it
    // is for, and it is loopback-only. What matters is a listener a tunnel could
    // be pointed at, so routes on the dashboard port are out of scope.
    const dashboardPort = this.config.caddy.dashboardListen.port;
    const exposedElsewhere = (target: { listen: string[] }): boolean =>
      target.listen.length === 0 || target.listen.some((entry) => !entry.endsWith(`:${dashboardPort}`));

    // Two different rules, because two different listeners:
    //  * the apps listener (a tunnel's target) must never reach one of our own
    //    ports at all — deployed apps are /api-agnostic by definition;
    //  * a gateway listener exists to reach exactly one service, the API (8787),
    //    so that one dial is legitimate and everything else is a hole.
    const appsPort = this.config.caddy.appsListen.port;
    const allowedOnGateway = new Set([8787]);

    const isOffending = (target: { listen: string[]; dial: string }): boolean => {
      const port = dialPort(target.dial);
      if (PRIVATE_PORTS[port] === undefined) return false;
      if (!exposedElsewhere(target)) return false;
      const onAppsListener = target.listen.some((entry) => entry.endsWith(`:${appsPort}`));
      if (onAppsListener) return true;
      return !allowedOnGateway.has(port);
    };

    try {
      const targets = await this.caddy.upstreamTargets();
      const offending = [
        ...new Map(
          targets
            .filter(isOffending)
            .map((target) => [`${target.listen.join(',')}|${target.dial}`, target]),
        ).values(),
      ];
      push(
        offending.length === 0
          ? {
              id: 'public-private-upstreams',
              title: 'No exposed listener proxies to a private port',
              status: 'pass',
              detail:
                targets.length === 0
                  ? 'no proxied routes yet'
                  : `${targets.length} proxied route(s), none on ${Object.keys(PRIVATE_PORTS).join('/')}`,
            }
          : {
              id: 'public-private-upstreams',
              title: 'No exposed listener proxies to a private port',
              status: 'warn',
              detail: offending
                .map((target) => `${target.listen.join(',') || target.server} → ${target.dial} (${PRIVATE_PORTS[dialPort(target.dial)] ?? 'private'})`)
                .join('; '),
              fix: 'Delete that route: the dashboard and the API belong on the loopback listeners, never on the apps port a tunnel exposes',
            },
      );
    } catch {
      push({
        id: 'public-private-upstreams',
        title: 'No exposed listener proxies to a private port',
        status: 'skip',
        detail: 'Caddy config could not be read',
        fix: 'Fix caddy-reachable first',
      });
    }

    // The other half of the same question: what does the tunnel point at? Read
    // from cloudflared's own ingress rules when they exist, so pointing a
    // hostname at the dashboard is caught before it is reachable.
    const ingress = readCloudflaredIngress();
    const dodgyIngress = (ingress ?? []).filter((rule) => PRIVATE_PORTS[servicePort(rule.service)] !== undefined);
    push(
      ingress === null
        ? {
            id: 'tunnel-targets',
            title: 'Tunnel ingress points only at intended listeners',
            status: 'skip',
            detail:
              'no local cloudflared config found — if the tunnel and its routes were created in the Cloudflare dashboard, ' +
              'they live in the account and cannot be checked from here; review Routes in the dashboard',
          }
        : dodgyIngress.length === 0
          ? {
              id: 'tunnel-targets',
              title: 'Tunnel ingress points only at intended listeners',
              status: 'pass',
              detail:
                ingress.length === 0
                  ? 'ingress file has no hostname rules'
                  : ingress.map((rule) => `${rule.hostname} → ${rule.service}`).join('; '),
            }
          : {
              id: 'tunnel-targets',
              title: 'Tunnel ingress points only at intended listeners',
              status: 'warn',
              detail: dodgyIngress
                .map((rule) => `${rule.hostname} → ${rule.service} (${PRIVATE_PORTS[servicePort(rule.service)] ?? 'private'})`)
                .join('; '),
              fix: 'Point public hostnames at the apps listener 127.0.0.1:8080, and hooks at 127.0.0.1:8081. Never at 8090/8787/5173/2019/2375',
            },
    );

    // A public base domain means deployed apps — and the hostname space around
    // them — are reachable by anyone. The dashboard stays loopback-only, but the
    // password is now the only thing standing between the internet and an admin
    // session, so 2FA stops being optional. A warning, not a failure: it is a
    // decision for the operator, not a broken install.
    const publicBases = this.config.caddy.allowedBaseDomains.filter((domain) => domain.includes('.'));
    push(
      publicBases.length === 0
        ? {
            id: 'public-domain-2fa',
            title: 'Public domain exposure has 2FA behind it',
            status: 'skip',
            detail: 'no public base domain configured — localhost only',
          }
        : admin?.totp_enabled === 1
          ? {
              id: 'public-domain-2fa',
              title: 'Public domain exposure has 2FA behind it',
              status: 'pass',
              detail: `public hosts under ${publicBases.join(', ')}, 2FA on, dashboard still loopback-only`,
            }
          : {
              id: 'public-domain-2fa',
              title: 'Public domain exposure has 2FA behind it',
              status: 'warn',
              detail:
                `${publicBases.join(', ')} is configured and 2FA is off. Fine while the dashboard stays on loopback ` +
                '(the internet cannot reach the login), but one password is all that protects it if it is ever exposed',
              fix: 'Recommended now, required before you add any tunnel route to the dashboard: Settings → Security → Enable 2FA',
            },
    );

    // -------------------------------------------------------------- github
    // Read-only integration; the only thing to report is whether it is alive and
    // how long the credential has left. Never the credential itself.
    {
      const github = getIntegration(this.db, 'github');
      const warningDays = this.config.github.expiryWarningDays;
      const days = github?.token_expires_at ? Math.ceil((github.token_expires_at - Date.now()) / 86_400_000) : null;

      push(
        github === null
          ? {
              id: 'github-integration',
              title: 'GitHub integration',
              status: 'skip',
              detail: 'not connected — repositories must be pasted as URLs',
            }
          : days === null
            ? {
                id: 'github-integration',
                title: 'GitHub integration',
                status: 'pass',
                detail: `connected as ${github.login}; token expiry not recorded (GitHub does not expose it — add it when reconnecting)`,
              }
            : days < 0
              ? {
                  id: 'github-integration',
                  title: 'GitHub integration',
                  status: 'fail',
                  detail: `token for ${github.login} expired ${Math.abs(days)} day(s) ago`,
                  fix: 'Create a new token and reconnect it in Settings → Integrations',
                }
              : days <= warningDays
                ? {
                    id: 'github-integration',
                    title: 'GitHub integration',
                    status: 'warn',
                    detail: `token for ${github.login} expires in ${days} day(s)`,
                    fix: 'Rotate the token in Settings → Integrations before it expires',
                  }
                : {
                    id: 'github-integration',
                    title: 'GitHub integration',
                    status: 'pass',
                    detail: `connected as ${github.login}, token expires in ${days} day(s)`,
                  },
      );
    }

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
      // The filesystem that holds the database and backups — the one that can
      // actually fill up because of CaptureHost.
      const usage = await Promise.race([
        diskUsageFor(this.config.dbPath),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);

      push({
        id: 'disk-space',
        title: 'Disk space',
        status:
          usage.use >= this.config.notify.diskThresholdPct
            ? 'fail'
            : usage.use >= this.config.notify.diskRecoverPct
              ? 'warn'
              : 'pass',
        detail: `${usage.use.toFixed(0)}% used on ${usage.mount} (holds ${usage.target}, threshold ${this.config.notify.diskThresholdPct}%)`,
        ...(usage.use >= this.config.notify.diskRecoverPct
          ? { fix: 'Prune our own images (per project), clear deployments/, prune old backups' }
          : {}),
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

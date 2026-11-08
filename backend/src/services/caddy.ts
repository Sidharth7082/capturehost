import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import {
  listSyncTargets,
  recordCheck,
  getDomain,
  type DomainTarget,
} from '../db/domains.repo.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';
import {
  CATCH_ALL_TAG,
  ROUTE_TAG_PREFIX as ROUTE_PREFIX,
  buildAppRoute,
  buildCatchAllRoute,
  isManagedRoute,
  probeHostname,
  routeTag,
  upstreamPortOf,
  type ProbeResult,
  type UpstreamPolicy,
} from './domains.js';

const run = promisify(execFile);

/**
 * Caddy admin API client + desired-state reconciler.
 *
 * The admin API has NO authentication, so it is bound to 127.0.0.1:2019 by the
 * Caddyfile and this client refuses to talk to anything else — a config typo
 * that pointed at a public address would hand Docker and the dashboard to the
 * internet, so it is rejected at construction, not documented.
 *
 * Only routes tagged `capturehost-<id>` are ever written or removed. Everything
 * else in the apps server (including the 404 catch-all) is preserved verbatim
 * and re-sent in the same order it arrived in.
 */

export interface CaddySyncResult {
  added: number;
  removed: number;
  repaired: number;
  drift: boolean;
}

export interface CaddyStatus {
  reachable: boolean;
  mode: AppConfig['caddy']['mode'];
  adminUrl: string;
  appsListen: string;
  dashboardListen: string;
  dashboardHost: string;
  version: string | null;
  managedRoutes: number;
  otherRoutes: number;
  drift: boolean;
  lastSyncAt: number | null;
  lastSync: CaddySyncResult | null;
  error: string | null;
}

export interface CaddyDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
}

interface ServerRef {
  name: string;
  routes: Record<string, unknown>[];
  /**
   * Caddy's admin API accepts an ARRAY on POST only when the list does not
   * exist yet (it creates it); once it exists, POST takes a single route and
   * appends it. Getting this wrong is a 500, so the distinction is tracked.
   */
  hasRoutes: boolean;
}

export class CaddyService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly policy: UpstreamPolicy;

  private timer: NodeJS.Timeout | null = null;
  private lastSyncAt: number | null = null;
  private lastSync: CaddySyncResult | null = null;
  private lastError: string | null = null;
  /** Serialises config writes so two syncs cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: CaddyDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;

    // The admin API is unauthenticated. Loopback or nothing.
    const admin = new URL(this.config.caddy.adminUrl);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(admin.hostname)) {
      throw new Error(
        `CADDY_ADMIN_URL must point at loopback (got ${admin.hostname}). The admin API has no authentication.`,
      );
    }

    this.policy = {
      portRangeStart: this.config.deploy.portRangeStart,
      portRangeEnd: this.config.deploy.portRangeEnd,
      // Never proxied, regardless of the range: the Docker proxy, the Caddy
      // admin API, the dashboard backend and the dev frontend.
      forbiddenPorts: [
        2375,
        2019,
        8787,
        this.config.caddy.dashboardListen.port,
        ...(this.config.isProduction ? [] : [5173]),
      ],
    };
  }

  // ------------------------------------------------------------------ HTTP

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;

    try {
      // Caddy's admin API rejects requests that carry no Origin (it answers
      // 403 "client is not allowed to access from origin ''"), so state the
      // loopback origin we are calling from on every request.
      const origin = this.config.caddy.adminUrl;

      response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Origin: origin,
          ...(body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.caddy.timeoutMs),
      });
    } catch (error) {
      throw new AppError(
        503,
        'caddy_unreachable',
        'Caddy is not reachable on its admin API. Is it running? (sudo systemctl start caddy)',
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError(
        502,
        'caddy_error',
        `Caddy refused the request (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }

    const raw = await response.text();
    return (raw === '' ? undefined : JSON.parse(raw)) as T;
  }

  private async configJson(): Promise<Record<string, unknown>> {
    return this.api<Record<string, unknown>>('GET', '/config/');
  }

  /**
   * Finds the server that serves the apps listener.
   *
   * With a Caddyfile-loaded config the server names are generated (srv0, srv1…),
   * so the listener is the only stable identifier.
   */
  private findAppsServer(config: Record<string, unknown>): ServerRef {
    const servers = (config.apps as { http?: { servers?: Record<string, { listen?: string[]; routes?: unknown[] }> } })
      ?.http?.servers;

    if (!servers) {
      throw new AppError(
        409,
        'caddy_no_apps_server',
        'Caddy has no HTTP apps configured. Copy deploy/caddy/Caddyfile to /etc/caddy/Caddyfile and reload it.',
      );
    }

    const wanted = `:${this.config.caddy.appsListen.port}`;

    for (const [name, server] of Object.entries(servers)) {
      const listen = server.listen ?? [];
      if (listen.some((entry) => entry.endsWith(wanted))) {
        const hasRoutes = Array.isArray(server.routes);
        return {
          name,
          hasRoutes,
          routes: hasRoutes ? (server.routes as Record<string, unknown>[]) : [],
        };
      }
    }

    throw new AppError(
      409,
      'caddy_no_apps_server',
      `Caddy has no server listening on ${wanted}. The apps site from deploy/caddy/Caddyfile is missing.`,
    );
  }

  // ------------------------------------------------------------- desired state

  private targetsWithPort(): DomainTarget[] {
    return listSyncTargets(this.db).filter(
      (target) => target.host_port !== null && target.container_id !== null,
    );
  }

  private desiredRoutes(targets: DomainTarget[], portOverride?: Map<number, number>): Record<string, unknown>[] {
    const routes: Record<string, unknown>[] = [];

    for (const target of targets) {
      const port = portOverride?.get(target.project_id) ?? target.host_port;
      if (port === null || port === undefined) continue;
      routes.push(buildAppRoute({ id: target.id, hostname: target.hostname }, port, this.policy));
    }

    return routes;
  }

  /**
   * Rewrites the routes this app owns, leaving everything else untouched.
   *
   * The admin API appends on POST and deletes by @id; it cannot replace a whole
   * array (PUT answers "key already exists"). So a rewrite is: delete every
   * route we tagged, then POST the full desired list in one array — which also
   * creates the list when it does not exist yet.
   */
  private async writeRoutes(server: ServerRef, desired: Record<string, unknown>[]): Promise<void> {
    const current = server.routes.filter(isManagedRoute);

    await this.deleteRoutes(current.map((route) => String(route['@id'])));
    await this.appendRoutes(server, [...desired, buildCatchAllRoute()]);
  }

  /**
   * Appends routes, respecting the array/single-object asymmetry above.
   * After the first append the list exists, so the rest go one by one.
   */
  private async appendRoutes(server: ServerRef, routes: Record<string, unknown>[]): Promise<void> {
    if (routes.length === 0) return;

    const path = `/config/apps/http/servers/${server.name}/routes`;

    if (!server.hasRoutes) {
      // The list does not exist yet: POST takes the whole array.
      await this.api('POST', path, routes);
      server.hasRoutes = true;
      return;
    }

    for (const route of routes) {
      await this.api('POST', path, route);
    }
  }

  /** Deletes one batch of managed routes by tag, ignoring unknown ones. */
  private async deleteRoutes(tags: string[]): Promise<void> {
    for (const tag of tags) {
      try {
        await this.api('DELETE', `/id/${tag}`);
      } catch {
        // 404: somebody else already removed it. Nothing to repair.
      }
    }
  }

  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    // Keep the chain alive even when an operation rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }

  // -------------------------------------------------------------------- sync

  /**
   * Reconciles SQLite (desired) against Caddy (actual).
   *
   * Called on startup, every CADDY_SYNC_INTERVAL_MS, after a deploy and after a
   * domain change. Returns what it had to change, which is what the UI shows as
   * "drift repaired".
   */
  async sync(reason = 'scheduled'): Promise<CaddySyncResult> {
    return this.serialise(async () => {
      const targets = this.targetsWithPort();
      const desired = this.desiredRoutes(targets);

      const config = await this.configJson();
      const server = this.findAppsServer(config);

      const currentManaged = server.routes.filter(isManagedRoute);
      const currentDomainRoutes = currentManaged.filter((route) => String(route['@id']) !== CATCH_ALL_TAG);
      const hasCatchAll = currentManaged.some((route) => String(route['@id']) === CATCH_ALL_TAG);
      const catchAllLast = hasCatchAll && String(server.routes.at(-1)?.['@id']) === CATCH_ALL_TAG;

      const desiredById = new Map(desired.map((route) => [String(route['@id']), route]));

      let added = 0;
      let removed = 0;
      let repaired = 0;

      for (const route of currentDomainRoutes) {
        const id = String(route['@id']);
        const wanted = desiredById.get(id);
        if (!wanted) {
          removed += 1;
          continue;
        }
        if (JSON.stringify(route) !== JSON.stringify(wanted)) repaired += 1;
      }

      for (const id of desiredById.keys()) {
        if (!currentDomainRoutes.some((route) => String(route['@id']) === id)) added += 1;
      }

      const drift = added > 0 || removed > 0 || repaired > 0 || !catchAllLast;
      const same = !drift && currentDomainRoutes.length === desired.length;

      if (!same) await this.writeRoutes(server, desired);

      // A route that exists and points somewhere is "active"; the HTTP probe is
      // a separate, explicit action (POST /api/domains/:id/check).
      const now = Date.now();
      const routedIds = new Set(desired.map((route) => String(route['@id'])));

      for (const target of targets) {
        if (!routedIds.has(routeTag(target.id))) continue;
        if (target.status !== 'active') {
          recordCheck(
            this.db,
            target.id,
            { status: 'active', latencyMs: target.latency_ms, error: null, httpsOk: target.https_ok === 1 ? true : null },
            now,
          );
        }
      }

      this.lastSyncAt = now;
      this.lastSync = { added, removed, repaired, drift };
      this.lastError = null;

      if (drift) {
        this.logger.info({ reason, added, removed, repaired }, 'caddy routes reconciled');
        writeAudit(this.db, {
          action: 'caddy.drift_repaired',
          actor: 'system',
          target: 'caddy',
          detail: `reason=${reason} added=${added} removed=${removed} repaired=${repaired}`,
        });
      }

      return this.lastSync;
    });
  }

  /**
   * Points a project's domains at a new port, without waiting for the periodic
   * sync. Used by the blue/green swap, which must know it succeeded before it
   * stops the old container.
   */
  async applyRoutesForProject(projectId: number, port: number): Promise<void> {
    return this.serialise(async () => {
      const targets = this.targetsWithPort().filter((target) => target.project_id === projectId);
      if (targets.length === 0) return;

      const desired = this.desiredRoutes(targets, new Map([[projectId, port]]));
      const config = await this.configJson();
      const server = this.findAppsServer(config);

      // Replace exactly this project's routes and re-append the catch-all last,
      // so the ordering survives every deploy.
      await this.deleteRoutes([...targets.map((target) => routeTag(target.id)), CATCH_ALL_TAG]);

      await this.appendRoutes(server, [...desired, buildCatchAllRoute()]);
    });
  }

  /** Called before a project's rows are deleted so its routes go with it. */
  async removeRoutesForProject(projectId: number): Promise<void> {
    return this.serialise(async () => {
      const config = await this.configJson();
      const server = this.findAppsServer(config);

      const tags: string[] = [];

      for (const route of server.routes.filter(isManagedRoute)) {
        const tag = String(route['@id']);
        if (tag === CATCH_ALL_TAG) continue;

        const id = Number(tag.replace(ROUTE_PREFIX, ''));
        const domain = Number.isInteger(id) ? getDomain(this.db, id) : null;
        // Drop it if it belongs to this project, or if the row is gone.
        if (!domain || domain.project_id === projectId) tags.push(tag);
      }

      await this.deleteRoutes([...tags, CATCH_ALL_TAG]);

      // Put the 404 back last: without it an unknown host would answer 200.
      await this.appendRoutes(server, [buildCatchAllRoute()]);
    });
  }

  /**
   * Confirms a hostname answers through the apps listener.
   * Retries briefly: Caddy applies a route asynchronously.
   */
  async verifyHostname(hostname: string, attempts = 5, delayMs = 400): Promise<ProbeResult> {
    let last: ProbeResult = {
      ok: false,
      status: null,
      latencyMs: null,
      httpsOk: null,
      error: 'not attempted',
    };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await probeHostname(hostname, {
        listen: this.config.caddy.appsListen,
        timeoutMs: Math.min(this.config.caddy.timeoutMs, 4000),
        useTls: this.config.caddy.mode === 'public',
      });

      if (last.ok) return last;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return last;
  }

  /** Health check for one domain, recorded on the row. */
  async checkDomain(domainId: number): Promise<ProbeResult> {
    const domain = getDomain(this.db, domainId);
    if (!domain) throw AppError.notFound('Domain not found');

    const result = await probeHostname(domain.hostname, {
      listen: this.config.caddy.appsListen,
      timeoutMs: this.config.caddy.timeoutMs,
      useTls: this.config.caddy.mode === 'public',
    });

    recordCheck(
      this.db,
      domainId,
      {
        status: result.ok ? 'active' : 'error',
        latencyMs: result.latencyMs,
        error: result.ok ? null : result.error ?? 'no response',
        httpsOk: result.httpsOk,
      },
      Date.now(),
    );

    return result;
  }

  // ------------------------------------------------------------------ status

  async status(): Promise<CaddyStatus> {
    const base: CaddyStatus = {
      reachable: false,
      mode: this.config.caddy.mode,
      adminUrl: this.config.caddy.adminUrl,
      appsListen: `${this.config.caddy.appsListen.host}:${this.config.caddy.appsListen.port}`,
      dashboardListen: `${this.config.caddy.dashboardListen.host}:${this.config.caddy.dashboardListen.port}`,
      dashboardHost: this.config.caddy.dashboardHost,
      version: null,
      managedRoutes: 0,
      otherRoutes: 0,
      drift: this.lastSync?.drift ?? false,
      lastSyncAt: this.lastSyncAt,
      lastSync: this.lastSync,
      error: this.lastError,
    };

    try {
      const config = await this.configJson();
      const server = this.findAppsServer(config);
      const ours = server.routes.filter(isManagedRoute);
      const managed = ours.filter((route) => String(route['@id']) !== CATCH_ALL_TAG);

      base.reachable = true;
      base.managedRoutes = managed.length;
      // "Other" means routes this app did not create at all.
      base.otherRoutes = server.routes.length - ours.length;
      base.version = await this.version();

      // Drift right now, not as of the last sync.
      const desired = this.desiredRoutes(this.targetsWithPort());
      base.drift =
        !server.routes.some((route) => String(route['@id']) === CATCH_ALL_TAG) ||
        managed.length !== desired.length ||
        desired.some(
          (route, index) =>
            JSON.stringify(route) !== JSON.stringify(managed[index]) ||
            upstreamPortOf(route) !== upstreamPortOf(managed[index] ?? {}),
        );

      return base;
    } catch (error) {
      base.error = error instanceof AppError ? error.message : 'Caddy unreachable';
      return base;
    }
  }

  private async version(): Promise<string | null> {
    try {
      const { stdout } = await run('caddy', ['version'], { timeout: 2000 });
      // `caddy version` prints "v2.11.8 h1:..."; keep just the version.
      return stdout.trim().split(/\s+/)[0]?.replace(/^v/, '') || null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- lifecycle

  start(): void {
    if (this.timer) return;

    // Repair on boot, then periodically: API-only routes do not survive a
    // Caddy reload, so drift is expected, not exceptional.
    void this.sync('startup').catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : 'sync failed';
      this.logger.warn({ err: error }, 'caddy sync failed at startup');
    });

    this.timer = setInterval(() => {
      void this.sync('interval').catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : 'sync failed';
        this.logger.warn({ err: error }, 'caddy sync failed');
      });
    }, this.config.caddy.syncIntervalMs);

    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

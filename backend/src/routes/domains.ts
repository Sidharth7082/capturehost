import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import {
  createDomain,
  deleteDomain,
  getDomain,
  getDomainByHostname,
  listDomains,
  listDomainsForProject,
  setDomainEnabled,
} from '../db/domains.repo.js';
import { getProject } from '../db/projects.repo.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import type { CaddyService } from '../services/caddy.js';
import type { DomainMonitor } from '../services/domainMonitor.js';
import { assertAllowedUpstream, normaliseHostname, validateHostname } from '../services/domains.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';

/** Domain routes: hostname validation, Caddy sync and health checks. */

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

const CreateDomainSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  hostname: z.string().min(1).max(300),
});

const PatchDomainSchema = z.object({ enabled: z.boolean() });

export interface DomainRoutesDeps {
  db: Db;
  config: AppConfig;
  caddy: CaddyService;
  /** Counts consecutive failures and raises the outage/recovery alerts. */
  monitor: DomainMonitor;
  logger: Logger;
}

function toDto(
  domain: ReturnType<typeof listDomains>[number],
  config: AppConfig,
  hostPort: number | null,
) {
  const listenPort = config.caddy.appsListen.port;
  // A tunnel serves real domains on 443 with Cloudflare's certificate; the
  // localhost names in the same list stay on the loopback apps listener. So the
  // scheme and port are decided per hostname, not per mode.
  const localHost = domain.hostname.endsWith('.localhost');
  const viaTunnel = config.caddy.mode === 'tunnel' && !localHost;
  const scheme = config.caddy.mode === 'public' || viaTunnel ? 'https' : 'http';
  // ... and only a loopback URL carries the apps port.
  const suffix = viaTunnel ? '' : scheme === 'https' && listenPort === 443 ? '' : `:${listenPort}`;

  return {
    id: domain.id,
    projectId: domain.project_id,
    projectName: domain.project_name,
    hostname: domain.hostname,
    url: `${scheme}://${domain.hostname}${suffix}`,
    status: domain.status,
    enabled: domain.enabled === 1,
    lastCheckedAt: domain.last_checked_at,
    lastError: domain.last_error,
    latencyMs: domain.latency_ms,
    httpsOk: domain.https_ok === null ? null : domain.https_ok === 1,
    upstreamPort: hostPort,
    createdAt: domain.created_at,
  };
}

export function registerDomainRoutes(app: AppInstance, deps: DomainRoutesDeps): void {
  const { db, config, caddy } = deps;

  const policy = {
    allowedBaseDomains: config.caddy.allowedBaseDomains,
    reservedHosts: [
      config.caddy.dashboardHost,
      ...(config.caddy.webhookPublicHost ? [config.caddy.webhookPublicHost] : []),
    ],
  };

  // ------------------------------------------------------------------- list
  app.get('/api/domains', async (request) => {
    requireAuth(request);

    const ports = new Map(
      (db.prepare('SELECT id, host_port FROM projects').all() as { id: number; host_port: number | null }[]).map(
        (row) => [row.id, row.host_port],
      ),
    );

    return { domains: listDomains(db).map((domain) => toDto(domain, config, ports.get(domain.project_id) ?? null)) };
  });

  // ----------------------------------------------------------------- create
  app.post('/api/domains', async (request) => {
    const session = requireAuth(request);
    const body = CreateDomainSchema.parse(request.body);

    const project = getProject(db, body.projectId);
    if (!project) throw AppError.notFound('Project not found');

    const hostname = normaliseHostname(body.hostname);
    const check = validateHostname(hostname, policy);

    if (!check.ok) {
      // A rejected hostname is worth recording: it is the only trace of an
      // attempt to attach something we do not allow.
      writeAudit(db, {
        action: 'domain.rejected',
        actor: session.username,
        target: hostname.slice(0, 200),
        detail: check.reason ?? 'invalid hostname',
        ip: request.ip,
        success: false,
      });
      throw AppError.badRequest(check.reason ?? 'Invalid hostname', 'invalid_hostname');
    }

    if (getDomainByHostname(db, check.hostname)) {
      throw AppError.conflict('That hostname is already attached to a project', 'hostname_taken');
    }

    const id = createDomain(db, { projectId: project.id, hostname: check.hostname, now: Date.now() });

    writeAudit(db, {
      action: 'domain.add',
      actor: session.username,
      target: check.hostname,
      detail: `project ${project.name}`,
      ip: request.ip,
    });

    // Apply immediately; a Caddy failure leaves the row pending with the reason.
    try {
      await caddy.sync('domain-add');
    } catch (error) {
      deps.logger.warn({ err: error, domainId: id }, 'caddy sync after domain add failed');
    }

    const domain = listDomains(db).find((entry) => entry.id === id);
    return { domain: domain ? toDto(domain, config, project.host_port) : null };
  });

  // ------------------------------------------------------------ enable/disable
  app.patch('/api/domains/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const body = PatchDomainSchema.parse(request.body);

    const domain = getDomain(db, id);
    if (!domain) throw AppError.notFound('Domain not found');

    setDomainEnabled(db, id, body.enabled, Date.now());

    writeAudit(db, {
      action: body.enabled ? 'domain.enable' : 'domain.disable',
      actor: session.username,
      target: domain.hostname,
      ip: request.ip,
    });

    try {
      await caddy.sync('domain-toggle');
    } catch (error) {
      deps.logger.warn({ err: error, domainId: id }, 'caddy sync after toggle failed');
    }

    const updated = listDomains(db).find((entry) => entry.id === id);
    const project = getProject(db, domain.project_id);
    return { domain: updated ? toDto(updated, config, project?.host_port ?? null) : null };
  });

  // ----------------------------------------------------------------- delete
  app.delete('/api/domains/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);

    const domain = getDomain(db, id);
    if (!domain) throw AppError.notFound('Domain not found');

    deleteDomain(db, id);

    writeAudit(db, {
      action: 'domain.remove',
      actor: session.username,
      target: domain.hostname,
      ip: request.ip,
    });

    try {
      await caddy.sync('domain-remove');
    } catch (error) {
      deps.logger.warn({ err: error, domainId: id }, 'caddy sync after delete failed');
    }

    return { ok: true };
  });

  // ------------------------------------------------------------------ check
  app.post('/api/domains/:id/check', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);

    const domain = getDomain(db, id);
    if (!domain) throw AppError.notFound('Domain not found');

    const result = await deps.monitor.checkOne(id);

    writeAudit(db, {
      action: 'domain.check',
      actor: session.username,
      target: domain.hostname,
      detail: result.ok ? `ok ${result.status}` : `failed: ${result.error ?? 'unknown'}`,
      ip: request.ip,
      success: result.ok,
    });

    return {
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
      consecutiveFailures: result.consecutiveFailures,
    };
  });

  // ------------------------------------------------------------------ caddy
  app.get('/api/caddy/status', async (request) => {
    requireAuth(request);
    return caddy.status();
  });

  // Everything attached to one project, used by the project overview.
  app.get('/api/projects/:id/domains', async (request) => {
    requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);

    const project = getProject(db, id);
    if (!project) throw AppError.notFound('Project not found');

    // A route may only point at the project's own live port; refuse to even
    // describe one that would break that rule.
    if (project.host_port !== null) {
      assertAllowedUpstream(project.host_port, {
        portRangeStart: config.deploy.portRangeStart,
        portRangeEnd: config.deploy.portRangeEnd,
        forbiddenPorts: [2375, 2019, 8787, config.caddy.dashboardListen.port],
      });
    }

    return {
      domains: listDomainsForProject(db, project.id).map((domain) => ({
        id: domain.id,
        hostname: domain.hostname,
        url: toDto(
          { ...domain, project_name: project.name, project_slug: project.slug } as never,
          config,
          project.host_port,
        ).url,
        status: domain.status,
        enabled: domain.enabled === 1,
        lastCheckedAt: domain.last_checked_at,
        lastError: domain.last_error,
      })),
    };
  });
}

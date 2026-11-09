import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { getDeployment, getProject, listDeployments, listProjects } from '../db/projects.repo.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import type { AgentAccessService, AgentIdentity } from '../services/agentAccess.js';
import type { DeploymentService } from '../services/deployments.js';
import { diagnoseDeployment } from '../services/diagnosis.js';
import { suggestForProject } from './dockerfile.js';
import type { Suggestion } from '../services/dockerfileSuggestion.js';
import { getDockerfileOverride, setDockerfileOverride } from '../db/dockerfile.repo.js';
import { writeAudit } from '../db/audit.repo.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { DoctorService } from '../services/doctor.js';
import { AppError } from '../utils/errors.js';
import { resolveClientIp } from '../utils/clientIp.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';

/**
 * The agent surface.
 *
 * Two audiences, two credential types, deliberately separated:
 *
 *   /api/agent/tokens*   the dashboard (session + CSRF) — create and revoke tokens
 *   /api/agent/tools/*   an external agent (bearer token) — a fixed list of verbs
 *
 * The verbs are reads plus one write ("deploy this project"). There is no shell, no
 * filesystem read, no Docker passthrough and no arbitrary SQL: an agent with a token
 * can ask CaptureHost to do what CaptureHost already knows how to do, and every call
 * lands in the audit log as `agent.<tool>` with the token's name.
 */

const IdParam = z.object({ id: z.coerce.number().int().positive() });

/** Both shapes the suggestion tool can return; annotated so the union type-checks. */
interface DockerfileToolResult {
  suggestion: Suggestion | null;
  files: string[];
  reason?: string;
  commit?: string;
  existingOverride?: { source: string; updatedAt: number } | null;
}

export interface AgentRoutesDeps {
  db: Db;
  access: AgentAccessService;
  deployments: Pick<DeploymentService, 'enqueueDeploy' | 'isBusy'>;
  doctor: Pick<DoctorService, 'run'>;
  /** Budget per token, so one runaway loop cannot fill the audit log. */
  limiter: SessionRateLimiter;
  trustedAddresses: readonly string[];
  config: AppConfig;
  logger: Logger;
}

type Ctx = { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> };

export function registerAgentRoutes(app: AppInstance, deps: AgentRoutesDeps): void {
  const clientIp = (request: Ctx): string =>
    resolveClientIp({
      peer: request.socket.remoteAddress,
      cfConnectingIp: request.headers['cf-connecting-ip'],
      trustedAddresses: deps.trustedAddresses,
    });

  /**
   * Every tool call: bearer token → permission → rate limit → handler → audit.
   *
   * The audit row is written with the tool name and the token's identity, never the
   * token itself, and it is written even when the handler throws (the `finally`
   * covers the common case of "the agent tried the same broken thing five times").
   */
  const runTool = async <T>(
    tool: string,
    request: FastifyRequest,
    handler: (identity: AgentIdentity) => Promise<{ result: T; target: string; detail?: string }>,
    options: { needsDeploy?: boolean } = {},
  ): Promise<T> => {
    const header = request.headers.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;

    const identity = deps.access.authenticate(token);
    if (options.needsDeploy && !identity.allowDeploy) {
      deps.access.auditTool(identity, tool, 'refused', 'read-only token', clientIp(request));
      throw AppError.forbidden('This token is read-only');
    }

    // The limiter is keyed per token, not per IP: several agents may share a laptop.
    const rate = deps.limiter.consume(`agent:${identity.id}`);
    if (!rate.allowed) {
      throw new AppError(429, 'rate_limited', 'Too many agent calls. Wait a moment.', {
        'retry-after': String(rate.retryAfterSeconds),
      });
    }

    try {
      const outcome = await handler(identity);
      deps.access.auditTool(identity, tool, outcome.target, outcome.detail, clientIp(request));
      return outcome.result;
    } catch (error) {
      deps.access.auditTool(
        identity,
        tool,
        'failed',
        error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
        clientIp(request),
      );
      throw error;
    }
  };

  // ------------------------------------------------------------- token admin
  app.get('/api/agent/tokens', async (request) => {
    requireAuth(request);
    return { tokens: deps.access.list() };
  });

  app.post('/api/agent/tokens', async (request) => {
    const session = requireAuth(request);
    const body = z
      .object({ name: z.string().min(2).max(60), allowDeploy: z.boolean().optional().default(false) })
      .parse(request.body ?? {});

    const created = deps.access.create(body, { actor: session.username, ip: clientIp(request) });
    // The only moment this value exists outside the caller's hands.
    return { id: created.id, token: created.token, tokens: deps.access.list() };
  });

  app.delete('/api/agent/tokens/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const revoked = deps.access.revoke(id, { actor: session.username, ip: clientIp(request) });
    if (!revoked) throw AppError.notFound('Token not found, or already revoked');
    return { revoked: true, tokens: deps.access.list() };
  });

  // ------------------------------------------------------------------ tools
  app.get('/api/agent/tools/whoami', async (request) =>
    runTool('whoami', request, async (identity) => ({
      target: identity.name,
      result: { name: identity.name, allowDeploy: identity.allowDeploy },
    })),
  );

  app.get('/api/agent/tools/projects', async (request) =>
    runTool('list_projects', request, async () => {
      const projects = listProjects(deps.db).map((project) => ({
        id: project.id,
        name: project.name,
        repoUrl: project.repo_url,
        branch: project.branch,
        status: project.status,
        hostPort: project.host_port,
        lastDeployedAt: project.last_deployed_at,
      }));
      return { target: `${projects.length} project(s)`, result: { projects } };
    }),
  );

  app.get('/api/agent/tools/projects/:id', async (request) =>
    runTool('get_project', request, async () => {
      const { id } = IdParam.parse(request.params);
      const project = getProject(deps.db, id);
      if (!project) throw AppError.notFound('Project not found');

      const deployments = listDeployments(deps.db, id, 10).map((deployment) => ({
        id: deployment.id,
        status: deployment.status,
        trigger: deployment.trigger,
        createdAt: deployment.created_at,
        error: deployment.error,
        diagnosis: diagnoseDeployment(deployment),
      }));

      return {
        target: project.name,
        result: {
          project: {
            id: project.id,
            name: project.name,
            repoUrl: project.repo_url,
            branch: project.branch,
            status: project.status,
            containerPort: project.container_port,
            hostPort: project.host_port,
            dockerfilePath: project.dockerfile_path,
          },
          deployments,
        },
      };
    }),
  );

  app.get('/api/agent/tools/deployments/:id', async (request) =>
    runTool('read_deployment', request, async () => {
      const { id } = IdParam.parse(request.params);
      const deployment = getDeployment(deps.db, id);
      if (!deployment) throw AppError.notFound('Deployment not found');

      return {
        target: `#${id}`,
        detail: deployment.status,
        result: {
          deployment: {
            id: deployment.id,
            projectId: deployment.project_id,
            status: deployment.status,
            error: deployment.error,
            trigger: deployment.trigger,
            createdAt: deployment.created_at,
            log: deployment.log ?? '',
            diagnosis: diagnoseDeployment(deployment),
          },
        },
      };
    }),
  );

  app.post('/api/agent/tools/projects/:id/deploy', async (request) =>
    runTool(
      'deploy_project',
      request,
      async () => {
        const { id } = IdParam.parse(request.params);
        const project = getProject(deps.db, id);
        if (!project) throw AppError.notFound('Project not found');
        if (deps.deployments.isBusy()) {
          throw AppError.conflict('A deployment is already running', 'deploy_busy');
        }

        const deploymentId = deps.deployments.enqueueDeploy(project, 'manual');
        return { target: project.name, detail: `deployment #${deploymentId}`, result: { queued: true, deploymentId } };
      },
      { needsDeploy: true },
    ),
  );

  /**
   * Reads only: clone the repository, look at its manifests, return a Dockerfile.
   * Nothing is saved — an agent may propose, but a deploy-capable token decides.
   */
  app.post('/api/agent/tools/projects/:id/suggest-dockerfile', async (request) =>
    runTool<DockerfileToolResult>('suggest_dockerfile', request, async () => {
      const { id } = IdParam.parse(request.params);
      const project = getProject(deps.db, id);
      if (!project) throw AppError.notFound('Project not found');

      const already = getDockerfileOverride(deps.db, project.id);
      const outcome = await suggestForProject({ config: deps.config, logger: deps.logger }, project);

      if (!outcome.suggestion) {
        return {
          target: project.name,
          detail: 'no recognised stack',
          result: {
            suggestion: null,
            files: outcome.files,
            reason:
              'No stack CaptureHost recognises (no package.json, requirements.txt, pyproject.toml, go.mod, composer.json, Gemfile, Cargo.toml or index.html at the top level).',
          },
        };
      }

      return {
        target: project.name,
        detail: outcome.suggestion.stack,
        result: {
          suggestion: outcome.suggestion,
          commit: outcome.commit,
          files: outcome.files,
          existingOverride: already ? { source: already.source, updatedAt: already.updatedAt } : null,
        },
      };
    }),
  );

  /**
   * Saves a Dockerfile for this project. Needs a deploy-capable token: it changes
   * what gets built. The repository's own Dockerfile still wins at build time.
   */
  app.put('/api/agent/tools/projects/:id/dockerfile', async (request) =>
    runTool(
      'set_project_dockerfile',
      request,
      async () => {
        const { id } = IdParam.parse(request.params);
        const project = getProject(deps.db, id);
        if (!project) throw AppError.notFound('Project not found');

        const body = z
          .object({ content: z.string().min(1).max(65_536), source: z.enum(['generated', 'edited']).default('generated') })
          .parse(request.body ?? {});
        if (!/\bFROM\b/i.test(body.content)) {
          throw AppError.badRequest('A Dockerfile needs at least one FROM instruction', 'invalid_dockerfile');
        }

        setDockerfileOverride(deps.db, project.id, body.content, body.source);
        writeAudit(deps.db, {
          action: 'project.dockerfile_saved',
          actor: 'agent',
          target: project.name,
          detail: `${body.source}, ${body.content.split('\n').length} lines`,
          ip: clientIp(request),
        });

        return {
          target: project.name,
          detail: body.source,
          result: { saved: true, dockerfilePath: project.dockerfile_path, lines: body.content.split('\n').length },
        };
      },
      { needsDeploy: true },
    ),
  );

  app.get('/api/agent/tools/doctor', async (request) =>
    runTool('run_doctor', request, async () => {
      const report = await deps.doctor.run();
      return {
        target: 'doctor',
        detail: `${report.summary.fail} fail, ${report.summary.warn} warn`,
        result: report,
      };
    }),
  );
}

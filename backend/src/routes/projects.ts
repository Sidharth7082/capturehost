import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import {
  createProject,
  deleteProject,
  getDeployment,
  getProject,
  getProjectByName,
  listDeployments,
  listProjects,
  setProjectSecrets,
  setProjectRuntime,
  updateProject,
  usedHostPorts,
  type DeploymentRow,
  type ProjectRow,
} from '../db/projects.repo.js';
import { encryptString, decryptString } from '../crypto/secretbox.js';
import { generateSessionToken } from '../crypto/token.js';
import { authenticateUpgrade, requireAuth, type UpgradeDeps } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import { BranchSchema, DockerfilePathSchema, RepoUrlSchema } from '../services/git.js';
import { clampResources, serializeCapabilities, slugify } from '../services/containerPolicy.js';
import type { DeploymentService } from '../services/deployments.js';
import type { LogHub } from '../services/logHub.js';
import type { DockerService } from '../services/docker.js';
import type { SocketRegistry } from '../services/socketRegistry.js';
import { AppError } from '../utils/errors.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';

const NameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes');

const OptionalTokenSchema = z.string().trim().min(1).max(255).optional();

const CreateProjectSchema = z.object({
  name: NameSchema,
  repoUrl: RepoUrlSchema,
  branch: BranchSchema.default('main'),
  dockerfilePath: DockerfilePathSchema.default('Dockerfile'),
  containerPort: z.coerce.number().int().min(1).max(65_535).default(80),
  healthPath: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/[A-Za-z0-9._\-\/]*$/, 'Health path must start with /')
    .optional(),
  cpuLimit: z.coerce.number().min(0.1).max(64).optional(),
  memoryLimitMb: z.coerce.number().int().min(64).max(65_536).optional(),
  pidsLimit: z.coerce.number().int().min(16).max(4096).optional(),
  // Validated against the capability allowlist inside the safety policy.
  capabilities: z.array(z.string().trim().min(1).max(32)).max(8).optional(),
  token: OptionalTokenSchema,
});

const UpdateProjectSchema = z.object({
  name: NameSchema.optional(),
  branch: BranchSchema.optional(),
  dockerfilePath: DockerfilePathSchema.optional(),
  containerPort: z.coerce.number().int().min(1).max(65_535).optional(),
  healthPath: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/[A-Za-z0-9._\-\/]*$/, 'Health path must start with /')
    .nullable()
    .optional(),
  cpuLimit: z.coerce.number().min(0.1).max(64).optional(),
  memoryLimitMb: z.coerce.number().int().min(64).max(65_536).optional(),
  pidsLimit: z.coerce.number().int().min(16).max(4096).optional(),
  capabilities: z.array(z.string().trim().min(1).max(32)).max(8).optional(),
  token: z.string().trim().max(255).nullable().optional(),
});

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const DeploymentParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  depId: z.coerce.number().int().positive(),
});
const EnvPutSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment keys must be letters, digits and underscores'),
  value: z.string().max(8192),
});
const EnvKeyParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  key: z.string().trim().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
});
const DeleteQuerySchema = z.object({ confirm: z.string().trim().min(1).max(64) });

export interface ProjectRoutesDeps extends UpgradeDeps {
  db: Db;
  deployments: DeploymentService;
  docker: DockerService;
  registry: SocketRegistry;
  logHub: LogHub;
  actions: SessionRateLimiter;
}

/** Safe projection: secrets never leave the server unless explicitly asked for. */
function toProjectDto(project: ProjectRow, config: AppConfig) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    repoUrl: project.repo_url,
    branch: project.branch,
    dockerfilePath: project.dockerfile_path,
    containerPort: project.container_port,
    hostPort: project.host_port,
    healthPath: project.health_path,
    status: project.status,
    url: project.host_port ? `http://127.0.0.1:${project.host_port}` : null,
    currentDeploymentId: project.current_deployment_id,
    lastDeployedAt: project.last_deployed_at,
    limits: {
      cpuLimit: project.cpu_limit,
      memoryLimitMb: project.memory_limit_mb,
      pidsLimit: project.pids_limit,
      maxMemoryMb: config.deploy.memoryMaxMb,
      maxCpu: config.deploy.cpuMax,
    },
    capabilities: project.capabilities.split(',').filter(Boolean),
    hasToken: project.github_token_encrypted !== null,
    hasWebhookSecret: project.webhook_secret_encrypted !== null,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

function toDeploymentDto(deployment: DeploymentRow) {
  return {
    id: deployment.id,
    projectId: deployment.project_id,
    commitSha: deployment.commit_sha,
    shortCommit: deployment.commit_sha?.slice(0, 7) ?? null,
    imageTag: deployment.image_tag,
    status: deployment.status,
    trigger: deployment.trigger,
    error: deployment.error,
    durationMs: deployment.duration_ms,
    rollbackOf: deployment.rollback_of,
    containerId: deployment.container_id,
    startedAt: deployment.started_at,
    finishedAt: deployment.finished_at,
    createdAt: deployment.created_at,
  };
}

export function registerProjectRoutes(app: AppInstance, deps: ProjectRoutesDeps): void {
  const { db, config } = deps;

  // ------------------------------------------------------------------ list
  app.get('/api/projects', async (request) => {
    requireAuth(request);
    const projects = listProjects(db);
    return { projects: projects.map((project) => toProjectDto(project, config)) };
  });

  // ---------------------------------------------------------------- create
  app.post('/api/projects', async (request) => {
    const session = requireAuth(request);
    const body = CreateProjectSchema.parse(request.body);

    if (getProjectByName(db, body.name)) {
      throw AppError.conflict('A project with that name already exists', 'name_taken');
    }

    const limits = clampResources(
      { memoryLimitMb: body.memoryLimitMb, cpuLimit: body.cpuLimit, pidsLimit: body.pidsLimit },
      config.deploy,
    );

    const now = Date.now();
    // The webhook secret is generated here, shown once, stored encrypted.
    const webhookSecret = generateSessionToken();

    const id = createProject(db, {
      name: body.name,
      slug: slugify(body.name),
      repoUrl: body.repoUrl,
      branch: body.branch,
      dockerfilePath: body.dockerfilePath,
      containerPort: body.containerPort,
      healthPath: body.healthPath ?? null,
      cpuLimit: limits.cpuLimit,
      memoryLimitMb: limits.memoryLimitMb,
      pidsLimit: limits.pidsLimit,
      capabilities: serializeCapabilities(body.capabilities),
      webhookSecretEncrypted: encryptString(webhookSecret, config.encryptionKey, 'project.webhook_secret'),
      githubTokenEncrypted: body.token
        ? encryptString(body.token, config.encryptionKey, 'project.github_token')
        : null,
      now,
    });

    writeAudit(db, {
      action: 'project.create',
      actor: session.username,
      target: body.name,
      detail: `${body.repoUrl} @ ${body.branch}`,
      ip: request.ip,
      now,
    });

    const project = getProject(db, id)!;
    return {
      project: toProjectDto(project, config),
      // Shown exactly once, like the TOTP recovery codes.
      webhookSecret,
      webhookPath: `/api/webhooks/github/${id}`,
    };
  });

  // ------------------------------------------------------------------- read
  app.get('/api/projects/:id', async (request) => {
    requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const project = getProject(db, id);
    if (!project) throw AppError.notFound('Project not found');

    const deployments = listDeployments(db, id, 20).map(toDeploymentDto);
    return { project: toProjectDto(project, config), deployments };
  });

  // ----------------------------------------------------------------- update
  app.patch('/api/projects/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const body = UpdateProjectSchema.parse(request.body);

    const project = getProject(db, id);
    if (!project) throw AppError.notFound('Project not found');

    if (body.name && body.name !== project.name && getProjectByName(db, body.name)) {
      throw AppError.conflict('A project with that name already exists', 'name_taken');
    }

    const limits = clampResources(
      {
        memoryLimitMb: body.memoryLimitMb ?? project.memory_limit_mb,
        cpuLimit: body.cpuLimit ?? project.cpu_limit,
        pidsLimit: body.pidsLimit ?? project.pids_limit,
      },
      config.deploy,
    );

    updateProject(
      db,
      id,
      {
        ...(body.name === undefined ? {} : { name: body.name, slug: slugify(body.name) }),
        ...(body.branch === undefined ? {} : { branch: body.branch }),
        ...(body.dockerfilePath === undefined ? {} : { dockerfilePath: body.dockerfilePath }),
        ...(body.containerPort === undefined ? {} : { containerPort: body.containerPort }),
        ...(body.healthPath === undefined ? {} : { healthPath: body.healthPath }),
        cpuLimit: limits.cpuLimit,
        memoryLimitMb: limits.memoryLimitMb,
        pidsLimit: limits.pidsLimit,
        ...(body.capabilities === undefined
          ? {}
          : { capabilities: serializeCapabilities(body.capabilities) }),
      },
      Date.now(),
    );

    if (body.token !== undefined) {
      setProjectSecrets(
        db,
        id,
        {
          githubTokenEncrypted: body.token
            ? encryptString(body.token, config.encryptionKey, 'project.github_token')
            : null,
        },
        Date.now(),
      );
    }

    writeAudit(db, {
      action: 'project.update',
      actor: session.username,
      target: project.name,
      detail: `fields: ${Object.keys(body).join(', ') || 'none'}`,
      ip: request.ip,
    });

    return { project: toProjectDto(getProject(db, id)!, config) };
  });

  // ----------------------------------------------------------------- delete
  app.delete('/api/projects/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const { confirm } = DeleteQuerySchema.parse(request.query);

    const project = getProject(db, id);
    if (!project) throw AppError.notFound('Project not found');
    if (confirm !== project.name) {
      throw AppError.badRequest('Confirmation does not match the project name', 'confirm_mismatch');
    }

    // Stop and remove the container before forgetting the project.
    if (project.container_id) {
      await deps.docker.removeContainerForProject(project.container_id);
    }

    // Images: capturehost/<slug>:* only, never anything else.
    await deps.docker.removeImagesForProject(project.slug);

    deleteProject(db, id);

    writeAudit(db, {
      action: 'project.delete',
      actor: session.username,
      target: project.name,
      detail: 'container and images removed',
      ip: request.ip,
    });

    return { ok: true };
  });

  // ----------------------------------------------------------------- deploy
  app.post('/api/projects/:id/deploy', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const project = getProject(db, id);
    if (!project) throw AppError.notFound('Project not found');

    consumeAction(deps, session.sessionId, 'deploy');
    const deploymentId = deps.deployments.enqueueDeploy(project, 'manual');

    writeAudit(db, {
      action: 'deploy.start',
      actor: session.username,
      target: project.name,
      detail: `deployment #${deploymentId}`,
      ip: request.ip,
    });

    return { ok: true, deploymentId };
  });

  app.get('/api/projects/:id/deployments', async (request) => {
    requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    if (!getProject(db, id)) throw AppError.notFound('Project not found');
    return { deployments: listDeployments(db, id, 50).map(toDeploymentDto) };
  });

  app.post('/api/projects/:id/deployments/:depId/cancel', async (request) => {
    const session = requireAuth(request);
    const { id, depId } = DeploymentParamSchema.parse(request.params);

    const deployment = getDeployment(db, depId);
    if (!deployment || deployment.project_id !== id) throw AppError.notFound('Deployment not found');

    deps.deployments.cancel(depId);

    writeAudit(db, {
      action: 'deploy.cancel',
      actor: session.username,
      target: `deployment #${depId}`,
      ip: request.ip,
    });

    return { ok: true };
  });

  app.post('/api/projects/:id/rollback', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const project = getProject(db, id);
    if (!project) throw AppError.notFound('Project not found');

    const target = deps.deployments.latestRollbackTarget(project.id, project.current_deployment_id ?? undefined);
    if (!target) throw AppError.badRequest('There is no previous successful deployment to roll back to', 'no_rollback_target');

    consumeAction(deps, session.sessionId, 'rollback');
    const deploymentId = deps.deployments.enqueueRollback(project, target);

    writeAudit(db, {
      action: 'deploy.rollback_requested',
      actor: session.username,
      target: project.name,
      detail: `#${deploymentId} back to ${target.image_tag}`,
      ip: request.ip,
    });

    return { ok: true, deploymentId, to: target.image_tag };
  });

  // ------------------------------------------------------------ environment
  app.get('/api/projects/:id/env', async (request) => {
    requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    if (!getProject(db, id)) throw AppError.notFound('Project not found');

    const rows = db.prepare('SELECT key FROM env_vars WHERE project_id = ? ORDER BY key').all(id) as {
      key: string;
    }[];

    // Key names and a masked flag. Values are never returned, not even masked
    // versions of them.
    return { env: rows.map((row) => ({ key: row.key, masked: true })) };
  });

  app.put('/api/projects/:id/env', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const body = EnvPutSchema.parse(request.body);

    if (!getProject(db, id)) throw AppError.notFound('Project not found');

    db.prepare(
      `INSERT INTO env_vars (project_id, key, value_encrypted, created_at)
       VALUES (@projectId, @key, @value, @now)
       ON CONFLICT(project_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted`,
    ).run({
      projectId: id,
      key: body.key,
      value: encryptString(body.value, config.encryptionKey, `project.env.${body.key}`),
      now: Date.now(),
    });

    writeAudit(db, {
      action: 'project.env.set',
      actor: session.username,
      target: `project ${id}`,
      detail: `key ${body.key}`,
      ip: request.ip,
    });

    return { ok: true, key: body.key };
  });

  app.delete('/api/projects/:id/env/:key', async (request) => {
    const session = requireAuth(request);
    const { id, key } = EnvKeyParamSchema.parse(request.params);
    if (!getProject(db, id)) throw AppError.notFound('Project not found');

    db.prepare('DELETE FROM env_vars WHERE project_id = ? AND key = ?').run(id, key);

    writeAudit(db, {
      action: 'project.env.delete',
      actor: session.username,
      target: `project ${id}`,
      detail: `key ${key}`,
      ip: request.ip,
    });

    return { ok: true };
  });

  // --------------------------------------------------------------- webhook UI
  app.get('/api/projects/:id/webhook', async (request) => {
    requireAuth(request);
    const { id } = IdParamSchema.parse(request.params);
    const project = getProject(db, id);
    if (!project) throw AppError.notFound('Project not found');

    // The secret is returned on demand so the operator can re-copy it; it is
    // never part of the project list payload.
    const secret = project.webhook_secret_encrypted
      ? decryptString(project.webhook_secret_encrypted, config.encryptionKey, 'project.webhook_secret')
      : null;

    return {
      path: `/api/webhooks/github/${project.id}`,
      secret,
      note: 'GitHub cannot reach 127.0.0.1 — expose only this path through a tunnel before using it.',
    };
  });

  // ------------------------------------------------------------ live logs WS
  app.get('/ws/deployments/:depId/logs', { websocket: true }, (socket, request) => {
    const rawSocket = socket as unknown as {
      readyState: number;
      bufferedAmount: number;
      send(data: string): void;
      close(code?: number, reason?: string): void;
      on(event: string, listener: (...args: never[]) => void): void;
    };

    const upgrade = authenticateUpgrade(request, deps);
    if (!upgrade.ok) {
      rawSocket.close(1008, upgrade.reason === 'origin' ? 'origin not allowed' : 'authentication required');
      return;
    }

    const parsed = z.object({ depId: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!parsed.success) {
      rawSocket.close(1008, 'invalid deployment id');
      return;
    }

    const deployment = getDeployment(db, parsed.data.depId);
    if (!deployment) {
      rawSocket.close(1008, 'deployment not found');
      return;
    }

    const session = upgrade.session;
    deps.registry.add(session.sessionId, rawSocket);

    const send = (frame: unknown): void => {
      if (rawSocket.readyState !== 1) return;
      if (rawSocket.bufferedAmount > 1_000_000) return; // slow reader: skip
      rawSocket.send(JSON.stringify(frame));
    };

    send({
      type: 'open',
      payload: { deploymentId: deployment.id, status: deployment.status, log: deployment.log ?? '' },
    });

    const unsubscribe = deps.logHub.subscribe(deployment.id, (line) => {
      send({ type: 'line', payload: { line } });
    });

    const cleanup = (): void => {
      unsubscribe();
      deps.registry.remove(session.sessionId, rawSocket);
    };

    rawSocket.on('close', cleanup);
    rawSocket.on('error', cleanup);
  });

  // Small helper the UI uses to know which ports are taken. Registered on its
  // own path (not /api/projects/:id/...) so it can never be captured by :id.
  app.get('/api/project-ports', async (request) => {
    requireAuth(request);
    const query = z.object({ projectId: z.coerce.number().int().positive().optional() }).parse(request.query);
    return {
      used: usedHostPorts(db, query.projectId),
      range: { start: config.deploy.portRangeStart, end: config.deploy.portRangeEnd },
    };
  });
}

function consumeAction(deps: ProjectRoutesDeps, sessionId: string, action: string): void {
  const result = deps.actions.consume(sessionId);
  if (result.allowed) return;

  writeAudit(deps.db, {
    action: 'deploy.rate_limited',
    actor: 'session',
    target: action,
    detail: 'per-session budget exhausted',
    success: false,
  });

  throw new AppError(429, 'rate_limited', 'Too many deploy actions. Wait a moment.', {
    'retry-after': String(result.retryAfterSeconds),
  });
}

import { DEFAULT_CAPABILITIES_CSV } from '../services/containerPolicy.js';
import type { Db } from './connection.js';

/** Row shapes and SQL for projects + deployments. No policy lives here. */

export interface ProjectRow {
  id: number;
  name: string;
  slug: string;
  repo_url: string;
  branch: string;
  dockerfile_path: string;
  container_port: number;
  host_port: number | null;
  health_path: string | null;
  cpu_limit: number;
  memory_limit_mb: number;
  pids_limit: number;
  capabilities: string;
  status: string;
  container_id: string | null;
  current_deployment_id: number | null;
  last_deployed_at: number | null;
  webhook_secret_encrypted: string | null;
  github_token_encrypted: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeploymentRow {
  id: number;
  project_id: number;
  commit_sha: string | null;
  image_tag: string | null;
  status: string;
  log: string | null;
  error: string | null;
  trigger: string;
  duration_ms: number | null;
  rollback_of: number | null;
  container_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export const DEPLOYMENT_STATES = [
  'queued',
  'cloning',
  'building',
  'starting',
  'health-check',
  'live',
  'failed',
  'cancelled',
  'rolled-back',
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

const PROJECT_COLUMNS = `
  id, name, slug, repo_url, branch, dockerfile_path, container_port, host_port, health_path,
  cpu_limit, memory_limit_mb, pids_limit, capabilities, status, container_id, current_deployment_id,
  last_deployed_at, webhook_secret_encrypted, github_token_encrypted, created_at, updated_at`;

export function listProjects(db: Db): ProjectRow[] {
  return db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at DESC`).all() as ProjectRow[];
}

export function getProject(db: Db, id: number): ProjectRow | null {
  const row = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
  return row ?? null;
}

export function getProjectByName(db: Db, name: string): ProjectRow | null {
  const row = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE name = ?`).get(name) as
    | ProjectRow
    | undefined;
  return row ?? null;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  containerPort: number;
  healthPath: string | null;
  cpuLimit: number;
  memoryLimitMb: number;
  pidsLimit: number;
  /** CSV. Optional here so callers that do not care get the policy default. */
  capabilities?: string;
  webhookSecretEncrypted: string | null;
  githubTokenEncrypted: string | null;
  now: number;
}

export function createProject(db: Db, input: CreateProjectInput): number {
  const result = db
    .prepare(
      `INSERT INTO projects
         (name, slug, repo_url, branch, dockerfile_path, container_port, health_path,
          cpu_limit, memory_limit_mb, pids_limit, capabilities, webhook_secret_encrypted,
          github_token_encrypted, status, created_at, updated_at)
       VALUES
         (@name, @slug, @repoUrl, @branch, @dockerfilePath, @containerPort, @healthPath,
          @cpuLimit, @memoryLimitMb, @pidsLimit, @capabilities, @webhookSecretEncrypted,
          @githubTokenEncrypted, 'idle', @now, @now)`,
    )
    .run({ ...input, capabilities: input.capabilities ?? DEFAULT_CAPABILITIES_CSV });

  return Number(result.lastInsertRowid);
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  branch?: string;
  dockerfilePath?: string;
  containerPort?: number;
  healthPath?: string | null;
  cpuLimit?: number;
  memoryLimitMb?: number;
  pidsLimit?: number;
  capabilities?: string;
}

export function updateProject(db: Db, id: number, input: UpdateProjectInput, now: number): void {
  const sets: string[] = ['updated_at = @now'];
  const params: Record<string, unknown> = { id, now };

  const map: Record<keyof UpdateProjectInput, string> = {
    name: 'name',
    slug: 'slug',
    branch: 'branch',
    dockerfilePath: 'dockerfile_path',
    containerPort: 'container_port',
    healthPath: 'health_path',
    cpuLimit: 'cpu_limit',
    memoryLimitMb: 'memory_limit_mb',
    pidsLimit: 'pids_limit',
    capabilities: 'capabilities',
  };

  for (const [key, column] of Object.entries(map) as [keyof UpdateProjectInput, string][]) {
    if (input[key] === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = input[key];
  }

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function setProjectRuntime(
  db: Db,
  id: number,
  runtime: {
    status?: string;
    hostPort?: number | null;
    containerId?: string | null;
    currentDeploymentId?: number | null;
    lastDeployedAt?: number | null;
  },
  now: number,
): void {
  const sets: string[] = ['updated_at = @now'];
  const params: Record<string, unknown> = { id, now };

  if (runtime.status !== undefined) {
    sets.push('status = @status');
    params.status = runtime.status;
  }
  if (runtime.hostPort !== undefined) {
    sets.push('host_port = @hostPort');
    params.hostPort = runtime.hostPort;
  }
  if (runtime.containerId !== undefined) {
    sets.push('container_id = @containerId');
    params.containerId = runtime.containerId;
  }
  if (runtime.currentDeploymentId !== undefined) {
    sets.push('current_deployment_id = @currentDeploymentId');
    params.currentDeploymentId = runtime.currentDeploymentId;
  }
  if (runtime.lastDeployedAt !== undefined) {
    sets.push('last_deployed_at = @lastDeployedAt');
    params.lastDeployedAt = runtime.lastDeployedAt;
  }

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function setProjectSecrets(
  db: Db,
  id: number,
  secrets: { webhookSecretEncrypted?: string | null; githubTokenEncrypted?: string | null },
  now: number,
): void {
  const sets: string[] = ['updated_at = @now'];
  const params: Record<string, unknown> = { id, now };

  if (secrets.webhookSecretEncrypted !== undefined) {
    sets.push('webhook_secret_encrypted = @webhook');
    params.webhook = secrets.webhookSecretEncrypted;
  }
  if (secrets.githubTokenEncrypted !== undefined) {
    sets.push('github_token_encrypted = @token');
    params.token = secrets.githubTokenEncrypted;
  }

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function deleteProject(db: Db, id: number): void {
  // Deployments, domains, env vars and deliveries cascade from projects.
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/** Host ports already taken by other projects, so allocation never collides. */
export function usedHostPorts(db: Db, exceptProjectId?: number): number[] {
  const rows = db
    .prepare(
      exceptProjectId === undefined
        ? 'SELECT host_port FROM projects WHERE host_port IS NOT NULL'
        : 'SELECT host_port FROM projects WHERE host_port IS NOT NULL AND id != ?',
    )
    .all(...(exceptProjectId === undefined ? [] : [exceptProjectId])) as { host_port: number }[];

  return rows.map((row) => row.host_port);
}

// ------------------------------------------------------------- deployments

const DEPLOYMENT_COLUMNS = `
  id, project_id, commit_sha, image_tag, status, log, error, trigger, duration_ms,
  rollback_of, container_id, started_at, finished_at, created_at`;

export interface CreateDeploymentInput {
  projectId: number;
  commitSha: string | null;
  imageTag: string | null;
  status: DeploymentState;
  trigger: 'manual' | 'webhook' | 'rollback';
  rollbackOf: number | null;
  now: number;
}

export function createDeployment(db: Db, input: CreateDeploymentInput): number {
  const result = db
    .prepare(
      `INSERT INTO deployments
         (project_id, commit_sha, image_tag, status, trigger, rollback_of, log, started_at, created_at)
       VALUES
         (@projectId, @commitSha, @imageTag, @status, @trigger, @rollbackOf, '', @now, @now)`,
    )
    .run(input);

  return Number(result.lastInsertRowid);
}

export function getDeployment(db: Db, id: number): DeploymentRow | null {
  const row = db.prepare(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = ?`).get(id) as
    | DeploymentRow
    | undefined;
  return row ?? null;
}

export function listDeployments(db: Db, projectId: number, limit = 50): DeploymentRow[] {
  return db
    .prepare(
      `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments
       WHERE project_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as DeploymentRow[];
}

export function updateDeployment(
  db: Db,
  id: number,
  patch: {
    status?: DeploymentState;
    commitSha?: string;
    imageTag?: string;
    error?: string | null;
    containerId?: string | null;
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
  },
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  const map: Record<string, string> = {
    status: 'status',
    commitSha: 'commit_sha',
    imageTag: 'image_tag',
    error: 'error',
    containerId: 'container_id',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    durationMs: 'duration_ms',
  };

  for (const [key, column] of Object.entries(map)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = value;
  }

  if (sets.length === 0) return;
  db.prepare(`UPDATE deployments SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/** Appends to the stored log, honouring the size cap (oldest bytes drop first). */
export function appendDeploymentLog(db: Db, id: number, chunk: string, maxBytes: number): void {
  const row = db.prepare('SELECT log FROM deployments WHERE id = ?').get(id) as { log: string | null } | undefined;
  const existing = row?.log ?? '';
  let next = existing + chunk;

  if (Buffer.byteLength(next, 'utf8') > maxBytes) {
    // Keep the tail: the end of a build is what matters when it fails.
    next = `[log truncated to last ${Math.round(maxBytes / 1024)} KB]\n${next.slice(-maxBytes)}`;
  }

  db.prepare('UPDATE deployments SET log = ? WHERE id = ?').run(next, id);
}

/** The most recent deployment that actually served traffic. */
export function previousSuccessfulDeployment(db: Db, projectId: number, excludeId?: number): DeploymentRow | null {
  const row = db
    .prepare(
      `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments
       WHERE project_id = ? AND status = 'live' AND image_tag IS NOT NULL
         AND (? IS NULL OR id != ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(projectId, excludeId ?? null, excludeId ?? null) as DeploymentRow | undefined;

  return row ?? null;
}

export function hasActiveDeployment(db: Db, projectId: number): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM deployments
       WHERE project_id = ? AND status IN ('queued','cloning','building','starting','health-check')`,
    )
    .get(projectId) as { count: number };

  return row.count > 0;
}

// ---------------------------------------------------------------- webhooks

/** Returns false when this delivery id was already processed. */
export function recordDelivery(
  db: Db,
  input: { deliveryId: string; projectId: number; event: string; action: string | null; now: number },
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, project_id, received_at, event, action)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.deliveryId, input.projectId, input.now, input.event, input.action);

  return result.changes === 1;
}

export function pruneDeliveries(db: Db, keepAfter: number): void {
  db.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').run(keepAfter);
}

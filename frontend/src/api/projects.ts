import { apiFetch } from './client';

/**
 * Phase 4: projects, deployments, environment variables and webhooks.
 *
 * Every state-changing call goes through `apiFetch`, which attaches the CSRF
 * header and forces a re-login only on a genuine 401.
 */

export type DeploymentStatus =
  | 'queued'
  | 'cloning'
  | 'building'
  | 'starting'
  | 'health-check'
  | 'live'
  | 'failed'
  | 'cancelled'
  | 'rolled-back';

export type ProjectStatus = 'idle' | 'deploying' | 'running' | 'stopped' | 'failed';

/** What the backend thinks went wrong, in one sentence. Null when nothing did. */
export interface Diagnosis {
  stage: 'clone' | 'dockerfile' | 'build' | 'start' | 'health' | 'live' | 'other';
  summary: string;
  hints: string[];
  actionable: boolean;
}

export interface ProjectLimits {
  cpuLimit: number;
  memoryLimitMb: number;
  pidsLimit: number;
  maxMemoryMb: number;
  maxCpu: number;
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  containerPort: number;
  hostPort: number | null;
  healthPath: string | null;
  status: ProjectStatus;
  url: string | null;
  currentDeploymentId: number | null;
  lastDeployedAt: number | null;
  limits: ProjectLimits;
  capabilities: string[];
  hasToken: boolean;
  hasWebhookSecret: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Deployment {
  id: number;
  /** Present on failure: one sentence about what went wrong, plus hints. */
  diagnosis?: Diagnosis | null;
  projectId: number;
  commitSha: string | null;
  shortCommit: string | null;
  imageTag: string | null;
  status: DeploymentStatus;
  trigger: 'manual' | 'webhook' | 'rollback';
  error: string | null;
  durationMs: number | null;
  rollbackOf: number | null;
  containerId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  containerPort: number;
  healthPath?: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
  token?: string;
}

export interface UpdateProjectInput {
  name?: string;
  branch?: string;
  dockerfilePath?: string;
  containerPort?: number;
  healthPath?: string | null;
  memoryLimitMb?: number;
  cpuLimit?: number;
  pidsLimit?: number;
  capabilities?: string[];
  token?: string | null;
}

export interface EnvKey {
  key: string;
  masked: true;
}

export interface WebhookInfo {
  path: string;
  secret: string | null;
  note: string;
}

export function fetchProjects(): Promise<{ projects: Project[] }> {
  return apiFetch('/api/projects');
}

export function fetchProject(id: number): Promise<{ project: Project; deployments: Deployment[] }> {
  return apiFetch(`/api/projects/${id}`);
}

export function createProject(
  input: CreateProjectInput,
): Promise<{ project: Project; webhookSecret: string; webhookPath: string }> {
  return apiFetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updateProject(id: number, input: UpdateProjectInput): Promise<{ project: Project }> {
  return apiFetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Deleting requires typing the project name — the backend checks it too. */
export function deleteProject(id: number, confirm: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/projects/${id}?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' });
}

export function deployProject(id: number): Promise<{ ok: boolean; deploymentId: number }> {
  return apiFetch(`/api/projects/${id}/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function fetchDeployments(id: number): Promise<{ deployments: Deployment[] }> {
  return apiFetch(`/api/projects/${id}/deployments`);
}

export function cancelDeployment(projectId: number, deploymentId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/projects/${projectId}/deployments/${deploymentId}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function rollbackProject(id: number): Promise<{ ok: boolean; deploymentId: number; to: string }> {
  return apiFetch(`/api/projects/${id}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function fetchEnv(id: number): Promise<{ env: EnvKey[] }> {
  return apiFetch(`/api/projects/${id}/env`);
}

export function putEnv(id: number, key: string, value: string): Promise<{ ok: boolean; key: string }> {
  return apiFetch(`/api/projects/${id}/env`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
}

export function deleteEnv(id: number, key: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/projects/${id}/env/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export function fetchWebhook(id: number): Promise<WebhookInfo> {
  return apiFetch(`/api/projects/${id}/webhook`);
}

export function deploymentLogSocketUrl(deploymentId: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/deployments/${deploymentId}/logs`;
}

/** Statuses where the pipeline is still working — used to poll faster. */
export const ACTIVE_STATUSES: readonly DeploymentStatus[] = [
  'queued',
  'cloning',
  'building',
  'starting',
  'health-check',
];

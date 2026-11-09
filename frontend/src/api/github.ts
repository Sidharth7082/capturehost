import { apiFetch } from './client';

/**
 * GitHub integration — read-only, and write-only for the credential.
 *
 * There is deliberately no `token` field in any type here: the API never returns
 * one, so the UI never has one to hold, render or log.
 */

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  /** Epoch ms, or null when no expiry was recorded (GitHub does not expose it). */
  expiresAt: number | null;
  daysUntilExpiry: number | null;
  lastValidatedAt: number | null;
  lastError: string | null;
  apiHost: string;
}

export interface GithubRepo {
  fullName: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string;
  language: string | null;
  updatedAt: string | null;
  htmlUrl: string;
}

export interface GithubRepoPage {
  repos: GithubRepo[];
  page: number;
  perPage: number;
  hasMore: boolean;
  totalCount: number | null;
  /** True when the backend answered from its 60-second ETag cache. */
  cached: boolean;
}

export function fetchGithubStatus(): Promise<GithubStatus> {
  return apiFetch<GithubStatus>('/api/github/status');
}

/** `expiresAt` is `YYYY-MM-DD` or null. The token is stored encrypted, never returned. */
export function connectGithub(token: string, expiresAt: string | null): Promise<GithubStatus> {
  return apiFetch<GithubStatus>('/api/github/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, expiresAt }),
  });
}

export function disconnectGithub(): Promise<{ connected: boolean; removed: boolean }> {
  return apiFetch<{ connected: boolean; removed: boolean }>('/api/github/disconnect', { method: 'DELETE' });
}

export function fetchGithubRepos(query: string, page: number): Promise<GithubRepoPage> {
  const params = new URLSearchParams({ query, page: String(page) });
  return apiFetch<GithubRepoPage>(`/api/github/repos?${params.toString()}`);
}

/** One repository only — never the whole list. */
export function checkGithubDockerfile(owner: string, repo: string): Promise<{ exists: boolean }> {
  return apiFetch<{ exists: boolean }>(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dockerfile`,
  );
}

import { apiFetch } from './client';

/** Phase 5: domains and the Caddy status banner. */

export type DomainStatus = 'pending' | 'active' | 'error';

export interface Domain {
  id: number;
  projectId: number;
  projectName: string;
  hostname: string;
  url: string;
  status: DomainStatus;
  enabled: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
  latencyMs: number | null;
  httpsOk: boolean | null;
  upstreamPort: number | null;
  createdAt: number;
}

export interface CaddyMode extends String {}

export interface CaddyStatus {
  reachable: boolean;
  mode: 'local' | 'tunnel' | 'public';
  adminUrl: string;
  appsListen: string;
  dashboardListen: string;
  dashboardHost: string;
  version: string | null;
  managedRoutes: number;
  otherRoutes: number;
  drift: boolean;
  lastSyncAt: number | null;
  lastSync: { added: number; removed: number; repaired: number; drift: boolean } | null;
  error: string | null;
}

export function fetchDomains(): Promise<{ domains: Domain[] }> {
  return apiFetch('/api/domains');
}

export function createDomain(projectId: number, hostname: string): Promise<{ domain: Domain | null }> {
  return apiFetch('/api/domains', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, hostname }),
  });
}

export function setDomainEnabled(id: number, enabled: boolean): Promise<{ domain: Domain | null }> {
  return apiFetch(`/api/domains/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export function deleteDomain(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/domains/${id}`, { method: 'DELETE' });
}

export function checkDomain(
  id: number,
): Promise<{ ok: boolean; status: number | null; latencyMs: number | null; error: string | null }> {
  return apiFetch(`/api/domains/${id}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function fetchCaddyStatus(): Promise<CaddyStatus> {
  return apiFetch('/api/caddy/status');
}

export interface ProjectDomain {
  id: number;
  hostname: string;
  status: DomainStatus;
  enabled: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export function fetchProjectDomains(projectId: number): Promise<{ domains: ProjectDomain[] }> {
  return apiFetch(`/api/projects/${projectId}/domains`);
}

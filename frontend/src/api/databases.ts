import { apiFetch } from './client';

/**
 * Databases (Phase 7).
 *
 * The password exists in exactly one response — the create call — and never again,
 * so there is no `password` field on the database type.
 */

export type DatabaseStatus = 'creating' | 'running' | 'stopped' | 'failed';

export interface LinkedProject {
  projectId: number;
  projectName: string;
  envKey: string;
}

export interface DatabaseInfo {
  id: number;
  name: string;
  engine: 'postgres';
  version: string;
  status: DatabaseStatus;
  containerName: string;
  volume: string;
  port: number | null;
  published: boolean;
  dbName: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastBackupAt: number | null;
  lastError: string | null;
  internalHost: string;
  internalPort: number;
  /** Connection URL without the password. */
  internalUrl: string;
  links: LinkedProject[];
}

export interface DatabaseBackup {
  fileName: string;
  createdAt: number;
  sizeBytes: number;
}

export interface TableInfo {
  schema: string;
  name: string;
  rows: number | null;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

export const POSTGRES_VERSIONS = ['17-alpine', '16-alpine'] as const;

export function fetchDatabases(): Promise<{ databases: DatabaseInfo[] }> {
  return apiFetch<{ databases: DatabaseInfo[] }>('/api/databases');
}

export function fetchDatabase(id: number): Promise<{ database: DatabaseInfo }> {
  return apiFetch<{ database: DatabaseInfo }>(`/api/databases/${id}`);
}

export function createDatabase(input: {
  name: string;
  version: string;
  published: boolean;
}): Promise<{ database: DatabaseInfo; password: string }> {
  return apiFetch<{ database: DatabaseInfo; password: string }>('/api/databases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function databaseAction(
  id: number,
  action: 'start' | 'stop' | 'restart',
): Promise<{ database: DatabaseInfo }> {
  return apiFetch<{ database: DatabaseInfo }>(`/api/databases/${id}/${action}`, { method: 'POST' });
}

export function deleteDatabase(
  id: number,
  confirm: string,
): Promise<{ removed: boolean; orphanedVolume: string; removeCommand: string }> {
  return apiFetch<{ removed: boolean; orphanedVolume: string; removeCommand: string }>(`/api/databases/${id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm }),
  });
}

export function fetchMetrics(id: number): Promise<{ sizeBytes: number; connections: number; version: string | null }> {
  return apiFetch(`/api/databases/${id}/metrics`);
}

export function fetchLogs(id: number, tail = 200): Promise<{ containerName: string; logs: string }> {
  return apiFetch(`/api/databases/${id}/logs?tail=${tail}`);
}

export function fetchTables(id: number): Promise<{ tables: TableInfo[] }> {
  return apiFetch<{ tables: TableInfo[] }>(`/api/databases/${id}/tables`);
}

export function fetchRows(id: number, schema: string, table: string, page: number): Promise<QueryResult> {
  return apiFetch<QueryResult>(
    `/api/databases/${id}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/rows?page=${page}`,
  );
}

export function runQuery(id: number, sql: string): Promise<QueryResult> {
  return apiFetch<QueryResult>(`/api/databases/${id}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
}

export function linkDatabase(
  id: number,
  projectId: number,
  envKey = 'DATABASE_URL',
): Promise<{ ok: true; redeployRequired: true; envKey: string }> {
  return apiFetch(`/api/databases/${id}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, envKey }),
  });
}

export function unlinkDatabase(id: number, projectId: number): Promise<{ ok: true }> {
  return apiFetch(`/api/databases/${id}/link/${projectId}`, { method: 'DELETE' });
}

export function fetchBackups(id: number): Promise<{ backups: DatabaseBackup[] }> {
  return apiFetch<{ backups: DatabaseBackup[] }>(`/api/databases/${id}/backups`);
}

export function createBackup(id: number): Promise<{ backup: DatabaseBackup }> {
  return apiFetch<{ backup: DatabaseBackup }>(`/api/databases/${id}/backups`, { method: 'POST' });
}

export function deleteBackup(id: number, fileName: string): Promise<{ ok: true }> {
  return apiFetch(`/api/databases/${id}/backups/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
}

export function restoreBackup(
  id: number,
  fileName: string,
  name: string,
): Promise<{ database: DatabaseInfo; password: string }> {
  return apiFetch<{ database: DatabaseInfo; password: string }>(
    `/api/databases/${id}/backups/${encodeURIComponent(fileName)}/restore`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
}

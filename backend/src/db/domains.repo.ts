import type { Db } from './connection.js';

/** Row shape + SQL for domains. Policy lives in services/domains.ts. */

export interface DomainRow {
  id: number;
  project_id: number;
  hostname: string;
  tls_enabled: number;
  status: 'pending' | 'active' | 'error';
  enabled: number;
  last_checked_at: number | null;
  last_error: string | null;
  latency_ms: number | null;
  https_ok: number | null;
  created_at: number;
  updated_at: number | null;
}

/** A domain joined with the runtime facts the Caddy sync needs. */
export interface DomainTarget extends DomainRow {
  project_name: string;
  project_slug: string;
  host_port: number | null;
  container_id: string | null;
}

const COLUMNS = `
  d.id, d.project_id, d.hostname, d.tls_enabled, d.status, d.enabled,
  d.last_checked_at, d.last_error, d.latency_ms, d.https_ok, d.created_at, d.updated_at`;

const TARGET_COLUMNS = `${COLUMNS}, p.name AS project_name, p.slug AS project_slug,
  p.host_port, p.container_id`;

export function listDomains(db: Db): (DomainRow & { project_name: string; project_slug: string })[] {
  return db
    .prepare(
      `SELECT ${COLUMNS}, p.name AS project_name, p.slug AS project_slug
       FROM domains d JOIN projects p ON p.id = d.project_id
       ORDER BY d.hostname`,
    )
    .all() as (DomainRow & { project_name: string; project_slug: string })[];
}

export function getDomain(db: Db, id: number): DomainRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM domains d WHERE d.id = ?`).get(id) as DomainRow | undefined;
  return row ?? null;
}

export function getDomainByHostname(db: Db, hostname: string): DomainRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM domains d WHERE d.hostname = ?`).get(hostname) as
    | DomainRow
    | undefined;
  return row ?? null;
}

export function listDomainsForProject(db: Db, projectId: number): DomainRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM domains d WHERE d.project_id = ? ORDER BY d.hostname`)
    .all(projectId) as DomainRow[];
}

export function createDomain(
  db: Db,
  input: { projectId: number; hostname: string; now: number },
): number {
  const result = db
    .prepare(
      `INSERT INTO domains (project_id, hostname, tls_enabled, status, enabled, created_at, updated_at)
       VALUES (@projectId, @hostname, 1, 'pending', 1, @now, @now)`,
    )
    .run(input);

  return Number(result.lastInsertRowid);
}

export function setDomainEnabled(db: Db, id: number, enabled: boolean, now: number): void {
  db.prepare(
    `UPDATE domains
     SET enabled = @enabled, status = @status, last_error = NULL, updated_at = @now
     WHERE id = @id`,
  ).run({ id, enabled: enabled ? 1 : 0, status: enabled ? 'pending' : 'pending', now });
}

export function recordCheck(
  db: Db,
  id: number,
  result: { status: 'pending' | 'active' | 'error'; latencyMs: number | null; error: string | null; httpsOk: boolean | null },
  now: number,
): void {
  db.prepare(
    `UPDATE domains
     SET status = @status, last_checked_at = @now, latency_ms = @latencyMs,
         last_error = @error, https_ok = @httpsOk, updated_at = @now
     WHERE id = @id`,
  ).run({
    id,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
    httpsOk: result.httpsOk === null ? null : result.httpsOk ? 1 : 0,
    now,
  });
}

export function deleteDomain(db: Db, id: number): void {
  db.prepare('DELETE FROM domains WHERE id = ?').run(id);
}

/**
 * Everything the Caddy sync wants: enabled domains whose project currently has
 * a published port. A project that has never deployed simply has no route yet.
 */
export function listSyncTargets(db: Db): DomainTarget[] {
  return db
    .prepare(
      `SELECT ${TARGET_COLUMNS}
       FROM domains d JOIN projects p ON p.id = d.project_id
       WHERE d.enabled = 1
       ORDER BY d.id`,
    )
    .all() as DomainTarget[];
}

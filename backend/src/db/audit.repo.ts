import type { Db } from './connection.js';

export interface AuditInput {
  action: string;
  actor: string;
  target?: string | null;
  detail?: string | null;
  ip?: string | null;
  success?: boolean;
  now?: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  actor: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  success: number;
}

/**
 * Appends one audit row.
 *
 * NEVER put a password, session token, TOTP code or recovery code in `detail`.
 * Callers pass short factual context ("container stopped", project id).
 * A failed audit write must never break the action it is recording, so the
 * caller decides how loud to be.
 */
export function writeAudit(db: Db, input: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_log (ts, action, actor, target, detail, ip, success)
     VALUES (@ts, @action, @actor, @target, @detail, @ip, @success)`,
  ).run({
    ts: input.now ?? Date.now(),
    action: input.action,
    actor: input.actor,
    target: input.target ?? null,
    detail: input.detail ?? null,
    ip: input.ip ?? null,
    success: input.success === false ? 0 : 1,
  });
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function listAudit(db: Db, limit: number, offset: number): AuditPage {
  const total = (db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count;
  const entries = db
    .prepare('SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as AuditEntry[];

  return { entries, total, limit, offset, hasMore: offset + entries.length < total };
}

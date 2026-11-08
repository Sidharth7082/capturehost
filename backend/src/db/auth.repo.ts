import type { Db } from './connection.js';

/**
 * Data access for everything auth-related. SQL lives here so the services
 * above stay readable and every statement is prepared once.
 */

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  last_password_change: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string; // sha256 of the cookie token
  admin_id: number;
  csrf_token: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  absolute_expires_at: number | null;
  kind: string;
}

export interface NewSession {
  id: string;
  adminId: number;
  csrfToken: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  kind: 'full' | 'pending_2fa';
}

const ADMIN_COLUMNS =
  'id, username, password_hash, totp_secret, totp_enabled, totp_last_step, last_password_change, created_at, updated_at';

export function getAdmin(db: Db): AdminRow | null {
  const row = db.prepare(`SELECT ${ADMIN_COLUMNS} FROM admin WHERE id = 1`).get() as AdminRow | undefined;
  return row ?? null;
}

export function getAdminByUsername(db: Db, username: string): AdminRow | null {
  const row = db.prepare(`SELECT ${ADMIN_COLUMNS} FROM admin WHERE username = ?`).get(username) as
    | AdminRow
    | undefined;
  return row ?? null;
}

export interface CreateAdminInput {
  username: string;
  passwordHash: string;
  now: number;
}

/** Only the CLI may call this. There is deliberately no HTTP route for it. */
export function createAdmin(db: Db, input: CreateAdminInput): number {
  const result = db
    .prepare(
      `INSERT INTO admin (id, username, password_hash, totp_enabled, created_at, updated_at)
       VALUES (1, ?, ?, 0, ?, ?)`,
    )
    .run(input.username, input.passwordHash, input.now, input.now);
  return Number(result.lastInsertRowid);
}

export function updateAdminPassword(db: Db, adminId: number, passwordHash: string, now: number): void {
  db.prepare('UPDATE admin SET password_hash = ?, last_password_change = ?, updated_at = ? WHERE id = ?').run(
    passwordHash,
    now,
    now,
    adminId,
  );
}

export function setTotpSecret(db: Db, adminId: number, encryptedSecret: string, now: number): void {
  db.prepare('UPDATE admin SET totp_secret = ?, totp_enabled = 0, totp_last_step = NULL, updated_at = ? WHERE id = ?').run(
    encryptedSecret,
    now,
    adminId,
  );
}

export function enableTotp(db: Db, adminId: number, now: number): void {
  db.prepare('UPDATE admin SET totp_enabled = 1, updated_at = ? WHERE id = ?').run(now, adminId);
}

export function disableTotp(db: Db, adminId: number, now: number): void {
  db.prepare(
    'UPDATE admin SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?',
  ).run(now, adminId);
}

export function recordTotpStep(db: Db, adminId: number, timeStep: number): void {
  db.prepare('UPDATE admin SET totp_last_step = ? WHERE id = ?').run(timeStep, adminId);
}

// ---------------------------------------------------------------- sessions

export function createSession(db: Db, session: NewSession): void {
  db.prepare(
    `INSERT INTO sessions
       (id, admin_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at, absolute_expires_at, kind)
     VALUES
       (@id, @adminId, @csrfToken, @ip, @userAgent, @createdAt, @createdAt, @idleExpiresAt, @absoluteExpiresAt, @kind)`,
  ).run(session);
}

export function getSession(db: Db, id: string): SessionRow | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ?? null;
}

export function touchSession(db: Db, id: string, lastSeenAt: number, idleExpiresAt: number): void {
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
    lastSeenAt,
    idleExpiresAt,
    id,
  );
}

export function rotateSession(
  db: Db,
  oldId: string,
  replacement: NewSession,
): void {
  // One transaction: the old token must never survive a half-applied rotation.
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(oldId);
    createSession(db, replacement);
  })();
}

export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function deleteSessionsForAdmin(db: Db, adminId: number, exceptId?: string): number {
  const result =
    exceptId === undefined
      ? db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId)
      : db.prepare('DELETE FROM sessions WHERE admin_id = ? AND id != ?').run(adminId, exceptId);
  return result.changes;
}

export function listSessions(db: Db, adminId: number): SessionRow[] {
  return db
    .prepare('SELECT * FROM sessions WHERE admin_id = ? ORDER BY last_seen_at DESC')
    .all(adminId) as SessionRow[];
}

/** Returns the ids that were removed, so callers can close their sockets. */
export function deleteExpiredSessions(db: Db, now: number): string[] {
  const expired = db
    .prepare('SELECT id FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?')
    .all(now, now) as { id: string }[];

  if (expired.length === 0) return [];

  const remove = db.prepare('DELETE FROM sessions WHERE id = ?');
  db.transaction(() => {
    for (const row of expired) remove.run(row.id);
  })();

  return expired.map((row) => row.id);
}

// ------------------------------------------------------------ recovery codes

export function insertRecoveryCodes(db: Db, adminId: number, hashes: string[], now: number): void {
  const insert = db.prepare('INSERT INTO recovery_codes (admin_id, code_hash, created_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const hash of hashes) insert.run(adminId, hash, now);
  })();
}

export function deleteRecoveryCodes(db: Db, adminId: number): void {
  db.prepare('DELETE FROM recovery_codes WHERE admin_id = ?').run(adminId);
}

/** Marks a matching unused code as consumed and returns whether it matched. */
export function consumeRecoveryCode(db: Db, adminId: number, codeHash: string, now: number): boolean {
  // The WHERE clause carries the one-time-use rule, so two concurrent requests
  // cannot both consume the same code.
  const result = db
    .prepare('UPDATE recovery_codes SET used_at = ? WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL')
    .run(now, adminId, codeHash);
  return result.changes === 1;
}

export function countUnusedRecoveryCodes(db: Db, adminId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE admin_id = ? AND used_at IS NULL')
    .get(adminId) as { count: number };
  return row.count;
}

// ------------------------------------------------------------ login attempts

export type AttemptKind = 'ip' | 'username';

export interface AttemptRow {
  kind: string;
  key: string;
  failures: number;
  first_at: number;
  last_at: number;
  locked_until: number | null;
}

export function getAttempt(db: Db, kind: AttemptKind, key: string): AttemptRow | null {
  const row = db.prepare('SELECT * FROM login_attempts WHERE kind = ? AND key = ?').get(kind, key) as
    | AttemptRow
    | undefined;
  return row ?? null;
}

export interface RecordFailureInput {
  kind: AttemptKind;
  key: string;
  now: number;
  windowMs: number;
  maxFailures: number;
  lockoutMs: number;
}

/**
 * Increments the failure counter and locks the key when it crosses the limit.
 *
 * The window resets when the first failure is older than `windowMs`, so five
 * failures spread over an hour do not lock anyone out. Once locked, each
 * further failure doubles the lockout, capped at 8x the base lockout — a
 * growing delay without an unbounded one.
 */
export function recordFailure(db: Db, input: RecordFailureInput): AttemptRow {
  const existing = getAttempt(db, input.kind, input.key);
  const windowExpired = existing !== null && input.now - existing.first_at > input.windowMs;

  const failures = existing === null || windowExpired ? 1 : existing.failures + 1;
  const firstAt = existing === null || windowExpired ? input.now : existing.first_at;

  let lockedUntil: number | null = existing?.locked_until ?? null;
  if (failures >= input.maxFailures) {
    const over = Math.max(0, failures - input.maxFailures);
    const multiplier = Math.min(2 ** over, 8);
    lockedUntil = input.now + input.lockoutMs * multiplier;
  }

  db.prepare(
    `INSERT INTO login_attempts (kind, key, failures, first_at, last_at, locked_until)
     VALUES (@kind, @key, @failures, @firstAt, @now, @lockedUntil)
     ON CONFLICT(kind, key) DO UPDATE SET
       failures = excluded.failures,
       first_at = excluded.first_at,
       last_at = excluded.last_at,
       locked_until = excluded.locked_until`,
  ).run({
    kind: input.kind,
    key: input.key,
    failures,
    firstAt,
    now: input.now,
    lockedUntil,
  });

  return {
    kind: input.kind,
    key: input.key,
    failures,
    first_at: firstAt,
    last_at: input.now,
    locked_until: lockedUntil,
  };
}

export function clearAttempts(db: Db, kind: AttemptKind, key: string): void {
  db.prepare('DELETE FROM login_attempts WHERE kind = ? AND key = ?').run(kind, key);
}

export function pruneAttempts(db: Db, olderThan: number): void {
  db.prepare('DELETE FROM login_attempts WHERE last_at < ? AND (locked_until IS NULL OR locked_until < ?)').run(
    olderThan,
    olderThan,
  );
}

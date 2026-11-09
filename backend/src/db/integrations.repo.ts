import type { Db } from './connection.js';

/**
 * Storage for provider integrations. One row per provider name.
 *
 * The encrypted token is an opaque blob to this layer — encryption and decryption
 * happen in the service that owns the credentials, so no repository ever holds a
 * plaintext secret.
 */

export interface IntegrationRow {
  name: string;
  token_encrypted: string;
  login: string;
  token_expires_at: number | null;
  connected_at: number;
  last_validated_at: number | null;
  last_error: string | null;
}

export function getIntegration(db: Db, name: string): IntegrationRow | null {
  const row = db.prepare('SELECT * FROM integrations WHERE name = ?').get(name) as IntegrationRow | undefined;
  return row ?? null;
}

export function upsertIntegration(
  db: Db,
  input: {
    name: string;
    tokenEncrypted: string;
    login: string;
    tokenExpiresAt: number | null;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO integrations (name, token_encrypted, login, token_expires_at, connected_at, last_validated_at, last_error)
     VALUES (@name, @tokenEncrypted, @login, @tokenExpiresAt, @now, @now, NULL)
     ON CONFLICT(name) DO UPDATE SET
       token_encrypted  = excluded.token_encrypted,
       login            = excluded.login,
       token_expires_at = excluded.token_expires_at,
       connected_at     = excluded.connected_at,
       last_validated_at= excluded.last_validated_at,
       last_error       = NULL`,
  ).run({
    name: input.name,
    tokenEncrypted: input.tokenEncrypted,
    login: input.login,
    tokenExpiresAt: input.tokenExpiresAt,
    now: input.now,
  });
}

/** Records the outcome of a validation/repos call without touching the token. */
export function touchIntegration(
  db: Db,
  name: string,
  update: { lastValidatedAt?: number; lastError?: string | null },
): void {
  db.prepare(
    `UPDATE integrations
        SET last_validated_at = COALESCE(@lastValidatedAt, last_validated_at),
            last_error        = @lastError
      WHERE name = @name`,
  ).run({
    name,
    lastValidatedAt: update.lastValidatedAt ?? null,
    lastError: update.lastError === undefined ? null : update.lastError,
  });
}

export function deleteIntegration(db: Db, name: string): boolean {
  const result = db.prepare('DELETE FROM integrations WHERE name = ?').run(name);
  return result.changes > 0;
}

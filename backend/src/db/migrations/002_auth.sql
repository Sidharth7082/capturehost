-- 002_auth.sql — everything Phase 2 needs on top of 001_core.
-- ALTER + new tables only; 001 is already applied and must not change.

-- Sessions: `id` now holds the SHA-256 of the cookie token, never the token.
-- expires_at is the *idle* deadline (slid forward on use); the new column is
-- the hard cap that no amount of activity can extend.
ALTER TABLE sessions ADD COLUMN absolute_expires_at INTEGER;
-- 'full' = real login. 'pending_2fa' = password accepted, waiting for a code.
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'full';

CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);

-- TOTP replay protection: the 30 s window of the last accepted code.
ALTER TABLE admin ADD COLUMN totp_last_step INTEGER;
ALTER TABLE admin ADD COLUMN last_password_change INTEGER;

-- Recovery codes are stored as SHA-256 hashes; the plaintext is shown once.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  code_hash  TEXT    NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_admin ON recovery_codes(admin_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_hash ON recovery_codes(code_hash);

-- Login throttling. Rows are per (kind, key): kind='ip' or kind='username'.
-- Kept in SQLite rather than memory so a restart cannot clear a lockout.
CREATE TABLE IF NOT EXISTS login_attempts (
  kind        TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  failures    INTEGER NOT NULL DEFAULT 0,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  locked_until INTEGER,
  PRIMARY KEY (kind, key)
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts(locked_until);

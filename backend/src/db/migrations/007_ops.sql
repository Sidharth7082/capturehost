-- 007_ops.sql — Phase 6: backups, notifications and their indexes.
--
-- New tables only (001–006 are applied); no ALTER needed.

CREATE TABLE IF NOT EXISTS backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT    NOT NULL UNIQUE,
  path        TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'scheduled'
                CHECK (kind IN ('scheduled', 'manual')),
  integrity   TEXT    NOT NULL DEFAULT 'ok',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);

-- In-app notification feed. `dedupe_key` + `created_at` is what the cooldown
-- checks, so one flapping container cannot page you every minute.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info', 'warning', 'error')),
  title       TEXT    NOT NULL,
  body        TEXT,
  dedupe_key  TEXT,
  meta        TEXT,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key, created_at DESC);

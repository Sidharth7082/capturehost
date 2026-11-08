-- 001_core.sql — baseline schema for CaptureHost.
--
-- Applied once by src/db/migrate.ts. Migrations are append-only:
-- never edit this file after it has run, add 002_*.sql instead.

CREATE TABLE IF NOT EXISTS admin (
  id            INTEGER PRIMARY KEY CHECK (id = 1), -- exactly one admin
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,           -- random 32-byte hex, not a JWT
  admin_id     INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  csrf_token   TEXT    NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL UNIQUE,
  repo_url        TEXT    NOT NULL,
  branch          TEXT    NOT NULL DEFAULT 'main',
  dockerfile_path TEXT    NOT NULL DEFAULT 'Dockerfile',
  container_name  TEXT,
  cpu_limit       REAL    NOT NULL DEFAULT 1.0,      -- cores
  memory_limit_mb INTEGER NOT NULL DEFAULT 512,
  status          TEXT    NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle', 'deploying', 'running', 'stopped', 'failed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha  TEXT,
  image_tag   TEXT,
  status      TEXT    NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'building', 'running', 'success', 'failed', 'rolled_back')),
  log_path    TEXT,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS domains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname    TEXT    NOT NULL UNIQUE,        -- example.capturehost.dev
  tls_enabled INTEGER NOT NULL DEFAULT 1 CHECK (tls_enabled IN (0, 1)),
  status      TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'error')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domains_project ON domains(project_id);

CREATE TABLE IF NOT EXISTS env_vars (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,
  -- AES-256-GCM ciphertext, never plaintext. Key comes from .env.
  value_encrypted TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS metrics (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,           -- epoch ms
  cpu_pct        REAL    NOT NULL,
  mem_used_bytes INTEGER NOT NULL,
  mem_total_bytes INTEGER NOT NULL,
  mem_pct        REAL    NOT NULL,
  disk_used_bytes INTEGER NOT NULL,
  disk_total_bytes INTEGER NOT NULL,
  disk_pct       REAL    NOT NULL,
  net_rx_bps     REAL    NOT NULL,
  net_tx_bps     REAL    NOT NULL,
  -- NULL = no GPU, or nvidia-smi unavailable. Never fake a zero.
  gpu_util_pct   REAL,
  gpu_mem_used_mb INTEGER,
  gpu_mem_total_mb INTEGER,
  gpu_temp_c     REAL,
  uptime_seconds INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  action  TEXT    NOT NULL,   -- e.g. 'auth.login', 'container.stop', 'domain.add'
  actor   TEXT    NOT NULL,   -- 'admin' or 'system'
  target  TEXT,               -- project id, container id, hostname ...
  detail  TEXT,               -- short human readable context, no secrets
  ip      TEXT,
  success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

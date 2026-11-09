-- Phase 7: Postgres databases owned by CaptureHost.
--
-- One row per database. The password is the only secret (encrypted with
-- APP_ENCRYPTION_KEY, context `database.password`); everything else here is safe
-- to show. `volume` is the Docker named volume the container is allowed to mount —
-- it is derived from the id and never taken from user input.

CREATE TABLE IF NOT EXISTS databases (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL UNIQUE,
  engine             TEXT    NOT NULL DEFAULT 'postgres',
  -- Pinned tag from the allowlist, e.g. "17-alpine". Never "latest".
  version            TEXT    NOT NULL,
  container_name     TEXT    NOT NULL UNIQUE,
  volume             TEXT    NOT NULL UNIQUE,
  -- Published host port, always on 127.0.0.1. NULL means internal-only.
  port               INTEGER,
  status             TEXT    NOT NULL DEFAULT 'creating',
  db_name            TEXT    NOT NULL,
  username           TEXT    NOT NULL,
  password_encrypted TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_backup_at     INTEGER,
  last_error         TEXT
);

-- A database can be linked to more than one project; a project links a given
-- database once, under one env var name.
CREATE TABLE IF NOT EXISTS project_databases (
  project_id  INTEGER NOT NULL,
  database_id INTEGER NOT NULL,
  env_key     TEXT    NOT NULL DEFAULT 'DATABASE_URL',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, database_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_databases_database ON project_databases(database_id);

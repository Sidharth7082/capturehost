-- 003_deployments.sql — Phase 4: projects, deployments, webhooks, env vars.
-- ALTER + new tables only; 001 and 002 are already applied.

-- A project now knows how to be run: which port the app listens on, an
-- optional health path, the host port we assigned, and which container of
-- ours is currently serving it.
ALTER TABLE projects ADD COLUMN slug TEXT;
ALTER TABLE projects ADD COLUMN container_port INTEGER NOT NULL DEFAULT 80;
ALTER TABLE projects ADD COLUMN host_port INTEGER;
ALTER TABLE projects ADD COLUMN health_path TEXT;
ALTER TABLE projects ADD COLUMN pids_limit INTEGER NOT NULL DEFAULT 256;
ALTER TABLE projects ADD COLUMN container_id TEXT;
ALTER TABLE projects ADD COLUMN current_deployment_id INTEGER;
ALTER TABLE projects ADD COLUMN last_deployed_at INTEGER;
-- Secrets at rest use the same AES-256-GCM key as TOTP (APP_ENCRYPTION_KEY).
ALTER TABLE projects ADD COLUMN webhook_secret_encrypted TEXT;
ALTER TABLE projects ADD COLUMN github_token_encrypted TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

-- Deployment bookkeeping: what triggered it, how long it took, and the
-- previous deployment a rollback went back to.
ALTER TABLE deployments ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE deployments ADD COLUMN duration_ms INTEGER;
ALTER TABLE deployments ADD COLUMN rollback_of INTEGER;
ALTER TABLE deployments ADD COLUMN container_id TEXT;
-- Full build log, capped by DEPLOY_MAX_LOG_BYTES when written.
ALTER TABLE deployments ADD COLUMN log TEXT;

CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(project_id, status);

-- GitHub delivery ids we have already processed. The primary key is the
-- X-GitHub-Delivery header: a replay simply fails to insert.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT    PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL,
  event       TEXT,
  action      TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_time ON webhook_deliveries(received_at);

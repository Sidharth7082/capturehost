-- 004_deployment_states.sql — Phase 4, second pass.
--
-- The deployment state list from 001 ('queued', 'building', 'running',
-- 'success', 'failed', 'rolled_back') does not describe the real pipeline:
-- a deployment clones, builds, starts, waits for a health check, and can be
-- cancelled. SQLite cannot alter a CHECK constraint, so the table is rebuilt
-- with the final vocabulary. Nothing references deployments by foreign key, so
-- the rebuild is safe; the rows are copied across unchanged.

CREATE TABLE deployments_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha      TEXT,
  image_tag       TEXT,
  -- queued -> cloning -> building -> starting -> health-check -> live
  -- (or failed / cancelled / rolled-back at any point)
  status          TEXT    NOT NULL DEFAULT 'queued'
                    CHECK (status IN (
                      'queued', 'cloning', 'building', 'starting', 'health-check',
                      'live', 'failed', 'cancelled', 'rolled-back'
                    )),
  error           TEXT,
  trigger         TEXT    NOT NULL DEFAULT 'manual'
                    CHECK (trigger IN ('manual', 'webhook', 'rollback')),
  duration_ms     INTEGER,
  rollback_of     INTEGER,
  container_id    TEXT,
  -- Full build log, capped in the service by DEPLOY_MAX_LOG_BYTES.
  log             TEXT,
  started_at      INTEGER,
  finished_at     INTEGER,
  created_at      INTEGER NOT NULL
);

INSERT INTO deployments_new
  (id, project_id, commit_sha, image_tag, status, error, trigger, duration_ms,
   rollback_of, container_id, log, started_at, finished_at, created_at)
SELECT
  id, project_id, commit_sha, image_tag,
  -- Map the old words onto the new ones so a pre-existing row stays valid.
  CASE status
    WHEN 'building'    THEN 'building'
    WHEN 'running'     THEN 'live'
    WHEN 'success'     THEN 'live'
    WHEN 'rolled_back' THEN 'rolled-back'
    ELSE status
  END,
  error, COALESCE(trigger, 'manual'), duration_ms, rollback_of, container_id, log,
  started_at, finished_at, created_at
FROM deployments;

DROP TABLE deployments;
ALTER TABLE deployments_new RENAME TO deployments;

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(project_id, status);

-- projects.status used ('idle', 'deploying', ...) which never matched the
-- pipeline either. The column is free-form TEXT with a CHECK of the same five
-- values, so only two are ever written: 'building' during a deploy and
-- 'running' or 'failed' after. No rebuild needed; 'idle' and 'deploying' were
-- already allowed by 001.

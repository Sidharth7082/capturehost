-- Agent access: tokens for an external agent to drive CaptureHost, and the notes
-- it (or the diagnosis engine) leaves behind.
--
-- Tokens are stored as SHA-256 hashes: the plaintext exists once, in the response
-- that created it. A token can be read-only or allowed to deploy; nothing here can
-- open a shell, touch the host filesystem or call Docker directly.

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  allow_deploy INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

-- What was tried and what the answer was, per project. Small on purpose: this is
-- a memory of failures, not a transcript.
CREATE TABLE IF NOT EXISTS agent_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  deployment_id INTEGER,
  kind       TEXT    NOT NULL,
  summary    TEXT    NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_notes_project ON agent_notes(project_id, created_at DESC);

-- A Dockerfile generated inside CaptureHost, for repositories that do not have one.
--
-- The repository's own Dockerfile always wins: this is only written into a clone
-- when the repository has nothing at the configured path. Stored as text because
-- it is source to be reviewed, not a secret.

ALTER TABLE projects ADD COLUMN dockerfile_override TEXT;
ALTER TABLE projects ADD COLUMN dockerfile_override_source TEXT;
ALTER TABLE projects ADD COLUMN dockerfile_override_at INTEGER;

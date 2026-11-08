-- 005_project_capabilities.sql — Phase 4: per-project Linux capabilities.
--
-- The safety policy drops ALL capabilities. A container that binds a privileged
-- port (80) or drops privileges to a worker user needs a few of them back —
-- stock nginx:alpine needs CHOWN (temp dirs), SETUID/SETGID (worker user) and
-- NET_BIND_SERVICE (port 80). Those four are the only ones the backend will
-- ever add; the policy allowlist is the real gate, this column only records
-- which of them a project asked for.
ALTER TABLE projects ADD COLUMN capabilities TEXT NOT NULL DEFAULT 'NET_BIND_SERVICE,CHOWN,SETUID,SETGID';

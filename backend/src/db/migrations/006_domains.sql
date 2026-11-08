-- 006_domains.sql — Phase 5: hostnames managed through Caddy.
--
-- ALTER only. `domains` already exists from 001 (hostname, tls_enabled,
-- status, created_at) with status in ('pending','active','error'), which is
-- still the right vocabulary: `enabled` says whether the operator wants the
-- route, `status` says whether Caddy actually has it.

ALTER TABLE domains ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE domains ADD COLUMN last_checked_at INTEGER;
ALTER TABLE domains ADD COLUMN last_error TEXT;
ALTER TABLE domains ADD COLUMN latency_ms INTEGER;
-- Only meaningful in public mode (a TLS probe through the listener).
ALTER TABLE domains ADD COLUMN https_ok INTEGER;
ALTER TABLE domains ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_domains_enabled ON domains(enabled);

-- 008_domain_health.sql — Phase 6 follow-up: consecutive domain check failures.
--
-- The alert fires on the third consecutive failure, so the counter has to live
-- with the domain rather than in a process that a restart would forget.
ALTER TABLE domains ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

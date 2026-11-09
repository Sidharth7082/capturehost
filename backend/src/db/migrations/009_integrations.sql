-- GitHub integration. One row per integration, keyed by name, so a second
-- provider never needs a new table.
--
-- The token itself lives ONLY in token_encrypted (AES-256-GCM, context-tagged by
-- the caller, keyed with APP_ENCRYPTION_KEY). Nothing else here is secret: the
-- login, the optional expiry the operator typed in, the last validation time and
-- the last error text are safe to show.
CREATE TABLE IF NOT EXISTS integrations (
  name              TEXT    PRIMARY KEY,
  token_encrypted   TEXT    NOT NULL,
  login             TEXT    NOT NULL,
  -- GitHub does not expose a personal access token's expiry through the API, so
  -- this is either the date the operator supplied when connecting, or NULL.
  token_expires_at  INTEGER,
  connected_at      INTEGER NOT NULL,
  last_validated_at INTEGER,
  last_error        TEXT
);

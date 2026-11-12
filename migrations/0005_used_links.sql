-- Single-use links consumed in SQL. A link is used by inserting its token hash (the link record's key, never the
-- token) in the same batch as the change it allows: a second use hits the primary key and the whole batch rolls back,
-- so nothing is changed twice. Rows older than twice the link lifetime are pruned by the consuming batch.
CREATE TABLE used_links (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) BETWEEN 1 AND 200),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 32),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  used_at INTEGER NOT NULL
);

CREATE INDEX used_links_used_at ON used_links(used_at);

-- A per-user version of the saved settings, bumped by every save and every clear. A setting link is bound to it when
-- made, and its save applies only while the version is unchanged, so a link never works again after any change.
ALTER TABLE users ADD COLUMN settings_version INTEGER NOT NULL DEFAULT 0;

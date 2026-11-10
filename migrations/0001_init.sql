-- gws-mcp schema. Invariant: no column may ever hold a message body, file content or plaintext token.
-- The only credential material is the AES-GCM encrypted refresh token (refresh_ct + refresh_iv).

-- id = "u_" + Google sub of the first account used to sign in.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  primary_email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Identity is the Google sub: emails can be recycled or renamed, a sub never moves to another person.
-- Emails always contain "@" and aliases never do, so an alias can never shadow another account's email.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL UNIQUE CHECK (instr(email, '@') > 1),
  google_sub TEXT NOT NULL UNIQUE CHECK (length(google_sub) > 0),
  alias TEXT CHECK (alias IS NULL OR (instr(alias, '@') = 0 AND length(alias) BETWEEN 1 AND 64)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect', 'disconnected')),
  refresh_ct TEXT,
  refresh_iv TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, alias),
  -- Target of the two-column grant foreign key: a grant can only name an account of its own user.
  UNIQUE (id, user_id),
  -- Ciphertext and IV exist together or not at all.
  CHECK ((refresh_ct IS NULL) = (refresh_iv IS NULL)),
  -- A disconnected account holds no refresh token.
  CHECK (status <> 'disconnected' OR refresh_ct IS NULL)
);

CREATE UNIQUE INDEX accounts_one_default ON accounts(user_id) WHERE is_default = 1;

-- Per MCP client allowlist of accounts. The account must belong to the grant's user.
CREATE TABLE client_grants (
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id, account_id),
  FOREIGN KEY (account_id, user_id) REFERENCES accounts(id, user_id) ON DELETE CASCADE
);

-- One row per SDK call. Metadata only; no body or content columns, ever.
-- Strings a snippet can influence are bounded so free text cannot be smuggled into audit rows.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  execute_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  account_id TEXT,
  fn TEXT NOT NULL CHECK (length(fn) BETWEEN 1 AND 200),
  effect TEXT NOT NULL CHECK (effect IN ('read', 'write')),
  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'planned', 'denied')),
  code TEXT CHECK (code IS NULL OR (code GLOB 'GWS_[A-Z]*' AND code NOT GLOB '*[^A-Z_]*' AND length(code) <= 64)),
  duration_ms INTEGER NOT NULL,
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 200),
  upstream_status INTEGER
);

CREATE INDEX audit_user_ts ON audit_log(user_id, ts);

-- Fixed-window rate limit counters.
CREATE TABLE rate_counters (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

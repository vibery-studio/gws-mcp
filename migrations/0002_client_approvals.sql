-- MCP client approvals, one row per OAuth grant minted at consent. This, not the OAuth provider's grant
-- listing (an eventually consistent KV list on Cloudflare), is the source of truth for which clients a user
-- approved and which grant ids a revoke must revoke. client_name is the self-asserted name as sanitized for
-- display at consent; it still needs HTML escaping.
CREATE TABLE client_approvals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 256),
  grant_id TEXT NOT NULL CHECK (length(grant_id) BETWEEN 1 AND 128),
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL,
  -- Grant ids are unique per user in the provider's key space (grant:<user>:<grant>).
  PRIMARY KEY (user_id, grant_id)
);

CREATE INDEX client_approvals_user_client ON client_approvals(user_id, client_id);

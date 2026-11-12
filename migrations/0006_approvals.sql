-- A person's approval of an AI app's plan whose steps need it (GWS_HUMAN_APPROVAL), given on the approval link's page.
-- Written in one batch with the link's use (`used_links`). An `apply: true` run uses one unused row of its plan hash,
-- user and client, given less than 10 minutes before, by a conditional UPDATE of `used_at`, so each approval runs once.
-- The approving batch prunes rows older than twice that.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 256),
  approved_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX approvals_plan ON approvals(plan_hash, user_id, client_id);
CREATE INDEX approvals_approved_at ON approvals(approved_at);

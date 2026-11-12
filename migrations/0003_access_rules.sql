-- Who may use this gws-mcp. A rule is an exact email ("ann@example.com") or a whole domain ("@example.com"),
-- lower-cased printable ASCII without spaces. A domain rule matches only the part after an email's last "@"
-- exactly: never a subdomain or a longer name ending the same way. The list lives only here, never in code or config.
CREATE TABLE access_rules (
  pattern TEXT PRIMARY KEY CHECK (
    length(pattern) BETWEEN 2 AND 320
    AND pattern = lower(pattern)
    AND pattern NOT GLOB '*[^!-~]*'
    AND substr(pattern, -1) <> '@'
    AND (
      -- "@domain": one leading "@", none after it.
      (substr(pattern, 1, 1) = '@' AND instr(substr(pattern, 2), '@') = 0)
      -- An exact email: an "@" after the first character.
      OR (substr(pattern, 1, 1) <> '@' AND instr(pattern, '@') > 1)
    )
  ),
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 300),
  created_at INTEGER NOT NULL
);

-- One row per change to access_rules. Metadata only: who changed it, how, what kind of rule, and the rule itself
-- (an admin must see who was added or removed). Never the whole list, never the note.
CREATE TABLE access_audit (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  -- A user id, or "migration" / "setup" for the rows those write.
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 300),
  via TEXT NOT NULL CHECK (via IN ('web', 'sdk', 'first-sign-in', 'setup', 'migration')),
  action TEXT NOT NULL CHECK (action IN ('add', 'role', 'remove')),
  pattern_kind TEXT NOT NULL CHECK (pattern_kind IN ('email', 'domain')),
  pattern TEXT NOT NULL CHECK (length(pattern) BETWEEN 2 AND 320),
  -- The rule's role after an add or role change; the removed rule's role for a remove.
  role TEXT NOT NULL CHECK (role IN ('admin', 'user'))
);

CREATE INDEX access_audit_ts ON access_audit(ts);

-- Every user that exists when this migration runs keeps working: their sign-in email becomes an admin rule. A
-- stored email that does not fit the rule shape is skipped (OR IGNORE), never stored half-valid.
INSERT OR IGNORE INTO access_rules (pattern, role, note, created_by, created_at)
SELECT lower(trim(primary_email)), 'admin', NULL, 'migration', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users;

INSERT INTO access_audit (id, ts, actor, via, action, pattern_kind, pattern, role)
SELECT lower(hex(randomblob(16))), created_at, 'migration', 'migration', 'add', 'email', pattern, role FROM access_rules;

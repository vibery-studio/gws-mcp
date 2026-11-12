import type { DatabaseSync } from "node:sqlite";
import initSql from "../../../migrations/0001_init.sql?raw";
import clientApprovalsSql from "../../../migrations/0002_client_approvals.sql?raw";
import accessRulesSql from "../../../migrations/0003_access_rules.sql?raw";
import userSettingsSql from "../../../migrations/0004_user_settings.sql?raw";
import usedLinksSql from "../../../migrations/0005_used_links.sql?raw";
import approvalsSql from "../../../migrations/0006_approvals.sql?raw";

/**
 * The D1 migrations (migrations/*.sql, the files wrangler applies to D1), embedded in the bundle so the host needs
 * no migrations folder at run time. Named by file name, as wrangler records them in `d1_migrations`.
 * test/node-host/shims.test.ts checks that this list is exactly the folder's files, in order, with the same text.
 */
export const D1_MIGRATIONS: readonly { name: string; sql: string }[] = [
  { name: "0001_init.sql", sql: initSql },
  { name: "0002_client_approvals.sql", sql: clientApprovalsSql },
  { name: "0003_access_rules.sql", sql: accessRulesSql },
  { name: "0004_user_settings.sql", sql: userSettingsSql },
  { name: "0005_used_links.sql", sql: usedLinksSql },
  { name: "0006_approvals.sql", sql: approvalsSql },
];

/** The table wrangler keeps for D1, with the same shape. */
const TRACKING_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

function appliedNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM d1_migrations").all() as Array<{ name: string }>).map((r) => r.name));
}

/**
 * How a database's recorded migrations compare with this build's, without changing it: `missing` are this build's
 * migrations it lacks (all of them when nothing is recorded), `unknown` are recorded ones this build does not have
 * (a newer gws-mcp migrated it).
 */
export function migrationState(db: DatabaseSync, migrations: readonly { name: string; sql: string }[] = D1_MIGRATIONS): { missing: string[]; unknown: string[] } {
  const tracked = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get() !== undefined;
  const applied = tracked ? appliedNames(db) : new Set<string>();
  const known = new Set(migrations.map((m) => m.name));
  return {
    missing: migrations.map((m) => m.name).filter((name) => !applied.has(name)),
    unknown: [...applied].filter((name) => !known.has(name)).sort(),
  };
}

/**
 * Applies the pending migrations in order, each once and each in its own write transaction, recording it in
 * `d1_migrations`. The applied set is read again under the write lock, so two processes opening the same file
 * apply each migration once. A database that records a migration this build does not know was migrated by a newer
 * gws-mcp and is refused. Returns the names applied now.
 */
export function applyMigrations(db: DatabaseSync, migrations: readonly { name: string; sql: string }[] = D1_MIGRATIONS): string[] {
  db.exec(TRACKING_SQL);
  const { unknown } = migrationState(db, migrations);
  if (unknown.length > 0) {
    throw new Error(`the database records migrations this gws-mcp does not have (${unknown.join(", ")}); it was migrated by a newer gws-mcp`);
  }
  const ran: string[] = [];
  for (const m of migrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!appliedNames(db).has(m.name)) {
        db.exec(m.sql);
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(m.name);
        ran.push(m.name);
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The failing statement may already have ended the transaction; its error is the one to report.
      }
      throw new Error(`database migration ${m.name} failed`, { cause: e });
    }
  }
  return ran;
}

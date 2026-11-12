import { chmodSync, closeSync, openSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { KV_SWEEP_BATCH, KV_TABLE_SQL, sweepExpiredKv } from "./kv";
import { applyMigrations, migrationState } from "./migrations";

/** How long a statement waits for another connection (an operator command on the same file) to release a lock. */
export const BUSY_TIMEOUT_MS = 5000;
/** Sweep passes per tick at most; the rest waits for the next tick (reads already hide expired entries). */
const MAX_SWEEP_PASSES = 10;

/**
 * Creates the database file owner-only (0600) when it is missing, and narrows an existing one to 0600: it holds the
 * sealed refresh tokens, the OAuth provider's records and the access list. SQLite gives its -wal and -shm files the
 * database file's mode.
 */
function privateFile(file: string): void {
  closeSync(openSync(file, "a", 0o600));
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
}

/**
 * Opens the host's one SQLite file: foreign keys on (as D1 enforces them), WAL so readers never wait for the
 * writer, a busy timeout for a second process, deleted content overwritten, then the D1 migrations and the KV
 * table. Returns the open connection and the migrations applied now.
 */
export function openDatabase(file: string): { db: DatabaseSync; applied: string[] } {
  if (file !== ":memory:") privateFile(file);
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: unknown } | undefined;
    if (file !== ":memory:" && mode?.journal_mode !== "wal") throw new Error(`the database could not switch to WAL (journal_mode=${String(mode?.journal_mode)})`);
    db.exec("PRAGMA secure_delete = ON");
    const applied = applyMigrations(db);
    db.exec(KV_TABLE_SQL);
    return { db, applied };
  } catch (e) {
    db.close();
    throw e;
  }
}

/** A database whose migrations are not exactly this build's. */
export class DatabaseVersionError extends Error {
  override readonly name = "DatabaseVersionError";
}

/**
 * Opens an existing database without changing its schema, for a command run beside the server: only the server
 * migrates an existing file (at boot), so a command of another version never alters the schema under a running
 * server. Refused (DatabaseVersionError) unless the file records exactly this build's migrations.
 */
export function openCurrentDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const { missing, unknown } = migrationState(db);
    if (unknown.length > 0) {
      throw new DatabaseVersionError(`the database was migrated by a newer gws-mcp (${unknown.join(", ")}); use the command of that version`);
    }
    if (missing.length > 0) {
      throw new DatabaseVersionError(
        `the database lacks this version's migrations (${missing.join(", ")}); start the server of this version first (it migrates at boot), then run the command again`,
      );
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** Removes expired KV entries in bounded passes; returns how many went. */
export function sweepKv(db: DatabaseSync, now: number = Date.now()): number {
  let removed = 0;
  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
    const n = sweepExpiredKv(db, now);
    removed += n;
    if (n < KV_SWEEP_BATCH) break;
  }
  return removed;
}

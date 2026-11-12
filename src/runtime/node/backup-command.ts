import { chmodSync, closeSync, constants, copyFileSync, existsSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXIT, isBusy, type CommandIo } from "./command-common";
import { loadNodeHostConfig, NodeHostConfigError, scrubSecretsFromEnv } from "./config";
import { BUSY_TIMEOUT_MS } from "./database";
import { D1_MIGRATIONS, migrationState } from "./migrations";

/**
 * The Node host's `backup <dest-file>` and `restore <src-file>` commands: copies of the one SQLite file, which holds
 * the sealed refresh tokens, the OAuth records and the access list. Both read the server's configuration (no secret)
 * to find the file. A backup holds encrypted data but is still sensitive; it is written owner-only (0600).
 *
 * - backup: `VACUUM INTO` makes a consistent copy while the server runs (a read transaction in WAL mode: the server
 *   keeps writing). The copy is built beside the destination and linked into place, so a destination that exists is
 *   never overwritten (not even by a race) and a failed backup leaves no partial file.
 * - restore: refused while any other connection has the database open. The test is SQLite's own: leaving WAL mode
 *   needs exclusive use of the file, so it fails while the server (or any command) holds a connection, from this or
 *   another container on the same volume. The probe connection then keeps an exclusive lock for the whole swap, so a
 *   server started meanwhile waits. The source must pass `integrity_check`, be a gws-mcp database (its recorded
 *   migrations are known to this build and include the first, and it has the tables they create) and not be migrated
 *   by a newer build. An older one is accepted: the server migrates it at boot. The current file is kept as
 *   `<db>.before-restore-<timestamp>`, then the verified copy replaces it with one rename.
 */

export const BACKUP_USAGE = `usage:
  backup <dest-file>     copy the database (safe while the server runs); refuses to overwrite a file
  restore <src-file>     replace the database with a backup; the server must be stopped`;

const SQLITE_MAGIC = "SQLite format 3\0";
/** How long the restore probe waits for a connection that may be closing; a running server never lets go. */
const PROBE_TIMEOUT_MS = 1500;

class Refusal extends Error {}

function describeSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${bytes} bytes` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function isSqliteFile(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.toString("latin1") === SQLITE_MAGIC;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function regularFile(file: string, what: string): void {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new Refusal(`${what} ${file} does not exist`);
  }
  if (!stat.isFile()) throw new Refusal(`${what} ${file} is not a regular file`);
}

/** Writes a verified, private copy of `source` (an open connection) to `dest`, never replacing an existing file. */
function copyInto(source: DatabaseSync, dest: string): number {
  const partial = `${dest}.partial-${process.pid}`;
  try {
    source.prepare("VACUUM INTO ?").run(partial);
    chmodSync(partial, 0o600);
    // link() fails with EEXIST instead of replacing: the check and the create are one step.
    linkSync(partial, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Refusal(`${dest} already exists; choose a new file name`);
    throw e;
  } finally {
    try {
      unlinkSync(partial);
    } catch {
      // Nothing was written, or it is already gone.
    }
  }
  return statSync(dest).size;
}

function backup(file: string, dest: string, io: CommandIo): number {
  regularFile(file, "the database");
  const target = path.resolve(dest);
  if (lstatOrNull(target) !== null) throw new Refusal(`${target} already exists; choose a new file name`);
  if (!existsSync(path.dirname(target))) throw new Refusal(`the folder ${path.dirname(target)} does not exist`);
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const size = copyInto(db, target);
    io.out(`backup written: ${target} (${describeSize(size)})`);
    return EXIT.ok;
  } finally {
    db.close();
  }
}

function lstatOrNull(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/** Opens the source read-only and proves it is a gws-mcp database this build can serve; returns the open connection. */
function openVerifiedSource(file: string): DatabaseSync {
  const notGws = (why: string) => new Refusal(`${file} is not a gws-mcp database (${why})`);
  if (!isSqliteFile(file)) throw notGws("not an SQLite file");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: unknown }>;
    if (check.length !== 1 || check[0]?.integrity_check !== "ok") throw new Refusal(`${file} failed the SQLite integrity check; it is damaged`);
    const tracked = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get() !== undefined;
    if (!tracked) throw notGws("no migration record");
    const { unknown } = migrationState(db);
    if (unknown.length > 0) throw new Refusal(`${file} was written by a newer gws-mcp (${unknown.join(", ")}); restore it with that version`);
    const applied = new Set((db.prepare("SELECT name FROM d1_migrations").all() as Array<{ name: string }>).map((r) => r.name));
    const first = D1_MIGRATIONS[0]?.name;
    if (first === undefined || !applied.has(first)) throw notGws("its first migration is not recorded");
    // The tables the recorded migrations create (from a fresh database built the same way) must all be there.
    const reference = new DatabaseSync(":memory:");
    try {
      for (const m of D1_MIGRATIONS) if (applied.has(m.name)) reference.exec(m.sql);
      const names = (conn: DatabaseSync) =>
        (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
      const have = new Set(names(db));
      const absent = names(reference).filter((n) => !have.has(n));
      if (absent.length > 0) throw notGws(`missing tables: ${absent.join(", ")}`);
    } finally {
      reference.close();
    }
    return db;
  } catch (e) {
    db.close();
    if (e instanceof Refusal) throw e;
    // "file is not a database" and the like: the file is not what it must be.
    if (isBusy(e)) throw e;
    throw notGws(e instanceof Error ? e.message.split("\n")[0] ?? "unreadable" : "unreadable");
  }
}

function restore(file: string, src: string, io: CommandIo, now: Date): number {
  const source = path.resolve(src);
  regularFile(source, "the backup");
  if (existsSync(file) && realpathSync(file) === realpathSync(source)) throw new Refusal("the backup is the live database file itself");
  const verified = openVerifiedSource(source);
  let probe: DatabaseSync | undefined;
  const staged = `${file}.restore-${process.pid}`;
  try {
    let kept: string | undefined;
    if (existsSync(file)) {
      regularFile(file, "the database");
      probe = new DatabaseSync(file);
      probe.exec(`PRAGMA busy_timeout = ${PROBE_TIMEOUT_MS}`);
      let mode: unknown;
      try {
        mode = (probe.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: unknown } | undefined)?.journal_mode;
      } catch (e) {
        if (isBusy(e)) throw new Refusal("the database is in use (the server is running, or another command has it open); stop the server, then restore");
        throw e;
      }
      if (mode !== "delete") throw new Refusal("the database is in use (the server is running); stop the server, then restore");
      // Hold the file exclusively until the swap is done.
      probe.exec("BEGIN EXCLUSIVE");
      kept = `${file}.before-restore-${stamp(now)}`;
      if (existsSync(kept)) throw new Refusal(`${kept} already exists; try again in a second`);
      copyFileSync(file, kept, constants.COPYFILE_EXCL);
      chmodSync(kept, 0o600);
    }
    try {
      copyInto(verified, staged);
      renameSync(staged, file);
    } finally {
      try {
        unlinkSync(staged);
      } catch {
        // Renamed into place, or never created.
      }
    }
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(`${file}${suffix}`);
      } catch {
        // Not there: the usual case once WAL mode is left.
      }
    }
    io.out(`restored ${source} as ${file}`);
    if (kept !== undefined) io.out(`the previous database is kept as ${kept}`);
    const { missing } = migrationState(verified);
    if (missing.length > 0) io.out(`the backup is from an older version: the server applies ${missing.join(", ")} when it starts`);
    return EXIT.ok;
  } finally {
    verified.close();
    probe?.close();
  }
}

/**
 * Runs `backup <dest>` or `restore <src>` and returns the exit code: 0 done, 1 refused (existing destination, server
 * running, not a gws-mcp database, newer version), 64 usage, 70 internal failure, 75 database busy, 78 configuration.
 * Prints plain lines, never a secret, never a stack.
 */
export async function runBackupCommand(
  action: "backup" | "restore",
  args: readonly string[],
  environment: Record<string, string | undefined>,
  io: CommandIo,
  now: Date = new Date(),
): Promise<number> {
  const [target, ...extra] = args;
  if (target === undefined || target === "" || target.startsWith("-") || extra.length > 0) {
    io.err(BACKUP_USAGE);
    return EXIT.usage;
  }
  try {
    const config = await loadNodeHostConfig(environment, { secrets: false });
    scrubSecretsFromEnv(environment);
    if (action === "backup") {
      if (!existsSync(config.dbFile)) throw new NodeHostConfigError(`there is no database at ${config.dbFile} (GWS_DB_FILE)`);
      return backup(config.dbFile, target, io);
    }
    return restore(config.dbFile, target, io, now);
  } catch (e) {
    if (e instanceof NodeHostConfigError) {
      io.err(`configuration error: ${e.message}`);
      return EXIT.config;
    }
    if (e instanceof Refusal) {
      io.err(`refused: ${e.message}`);
      return EXIT.refused;
    }
    if (isBusy(e)) {
      io.err("the database is busy (another process holds it); nothing changed; try again");
      return EXIT.tempfail;
    }
    io.err(`failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 300)}`);
    return EXIT.software;
  }
}

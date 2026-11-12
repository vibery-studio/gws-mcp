import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { z } from "zod";
import initSql from "../../migrations/0001_init.sql?raw";
import clientApprovalsSql from "../../migrations/0002_client_approvals.sql?raw";
import accessRulesSql from "../../migrations/0003_access_rules.sql?raw";
import userSettingsSql from "../../migrations/0004_user_settings.sql?raw";
import usedLinksSql from "../../migrations/0005_used_links.sql?raw";
import type { Config } from "../config";
import type { AuditSink, LinkStore, RateCounter, SecretSource, TokenCache } from "../core/ports";
import { GwsError, isGwsError } from "../errors";
import type { GoogleOAuth } from "../google/oauth";
import { KEY_VERSION, decrypt, encrypt, importKey, tokenAad, type Sealed } from "../store/crypto";
import { openStore, type Store, type StoreEnv } from "../store/db";
import { openUserSettings, type UserSettingsStore } from "../store/user-settings";
import { ensurePrivateDir, ensurePrivateFile, type PathCheck } from "./paths";
import type { Redactor } from "./secrets";

/** The database file in the config directory. */
export const DB_FILE = "gws-mcp.db";
/** The one local user: the person running the process. Every account belongs to it. */
export const LOCAL_USER_ID = "local";

/** SQLite writes these beside the database; they hold the same data, so they get the same checks. */
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
/** How long a statement waits for another process (`serve` and the CLI share the file) to release a lock. */
const BUSY_TIMEOUT_MS = 5000;

// ---- Migrations -----------------------------------------------------------------------------------------

/**
 * Local-only schema. Single-use link records (connect requests) live in SQLite instead of KV, and the local user
 * row exists from the start (accounts reference it). The remote tables for client grants and approvals exist but
 * stay empty: the local runtime has no client approval layer.
 */
const LOCAL_LINKS_AND_USER_SQL = `
CREATE TABLE links (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 256),
  value TEXT NOT NULL CHECK (length(value) <= 65536),
  expires_at INTEGER NOT NULL
);
CREATE INDEX links_expires_at ON links(expires_at);
INSERT INTO users (id, primary_email, created_at)
  VALUES ('${LOCAL_USER_ID}', '${LOCAL_USER_ID}', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
`;

/** Which Google upstream minted the tokens this database holds (`google` or `fake`), recorded at creation. */
const META_SQL = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/**
 * Versioned schema changes, applied in order; `PRAGMA user_version` records the last one applied. The first two
 * are the remote D1 migrations themselves, so both runtimes share one schema for accounts, audit and rate counters.
 */
export const LOCAL_MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  { version: 1, name: "0001_init", sql: initSql },
  { version: 2, name: "0002_client_approvals", sql: clientApprovalsSql },
  { version: 3, name: "local_links_and_user", sql: LOCAL_LINKS_AND_USER_SQL },
  { version: 4, name: "local_meta", sql: META_SQL },
  // The access list's tables, for one schema in both runtimes. Locally they stay empty and nothing reads them: the
  // local server serves only the person running it, over stdio or a loopback page, with no sign-in and no other users
  // to admit. (Its seed skips the local user, whose stored email is not an address.)
  { version: 5, name: "0003_access_rules", sql: accessRulesSql },
  // The local user's Google Ads settings, sealed with the keychain (or key file) key like the refresh tokens.
  { version: 6, name: "0004_user_settings", sql: userSettingsSql },
  // Single-use link consumption and the settings version. Locally no setting link is made (no web page), but every
  // save and clear bumps the version, so both runtimes share the settings code and schema.
  { version: 7, name: "0005_used_links", sql: usedLinksSql },
];
export const SCHEMA_VERSION = LOCAL_MIGRATIONS.length;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  const v = row?.user_version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new GwsError("GWS_INTERNAL", "the database schema version is unreadable");
  return v;
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = fn();
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failed statement may already have ended the transaction; the original error is what matters.
    }
    throw e;
  }
  db.exec("COMMIT");
  return result;
}

/** Applies the pending migrations, each in its own transaction (which also serializes two processes opening). */
function migrate(db: DatabaseSync): number {
  if (userVersion(db) > SCHEMA_VERSION) {
    throw new GwsError("GWS_INTERNAL", "the database was created by a newer gws-mcp; upgrade gws-mcp to use it");
  }
  for (const m of LOCAL_MIGRATIONS) {
    try {
      inTransaction(db, () => {
        // Read again under the write lock: another process may have applied it meanwhile.
        if (userVersion(db) >= m.version) return;
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      });
    } catch (e) {
      if (isGwsError(e)) throw e;
      throw new GwsError("GWS_INTERNAL", `database migration ${m.name} failed`, { cause: e });
    }
  }
  return userVersion(db);
}

/** Records the upstream in a new database, or refuses an existing one recorded for the other upstream. */
function bindUpstream(db: DatabaseSync, upstream: Config["GOOGLE_UPSTREAM"]): void {
  const recorded = inTransaction(db, () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('upstream', ?) ON CONFLICT (key) DO NOTHING").run(upstream);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'upstream'").get() as { value?: unknown } | undefined;
    return row?.value;
  });
  if (recorded !== upstream) {
    throw new GwsError(
      "GWS_INTERNAL",
      `this database holds accounts connected through the ${String(recorded)} upstream; refusing to use it with the ${upstream} upstream (use another config directory)`,
    );
  }
}

// ---- D1-compatible statements over node:sqlite -----------------------------------------------------------

/**
 * The part of D1 that `openStore` (src/store/db.ts) uses: `prepare(sql).bind(...).first() | all() | run()` and
 * `batch([...])` as one transaction. Running the remote store over it keeps one implementation (one set of SQL,
 * validation and account rules) for both runtimes.
 */
class SqliteStatement {
  constructor(
    private readonly prepared: (sql: string) => StatementSync,
    private readonly sql: string,
    private readonly params: readonly SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.prepared, this.sql, values.map(toSqlValue));
  }

  firstSync(): unknown {
    return this.prepared(this.sql).get(...this.params) ?? null;
  }

  runSync(): { success: true; meta: { changes: number } } {
    const r = this.prepared(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }

  async first(): Promise<unknown> {
    return this.firstSync();
  }

  async all(): Promise<{ results: unknown[]; success: true }> {
    return { results: this.prepared(this.sql).all(...this.params), success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync();
  }
}

/** D1 refuses `undefined` and objects too; booleans are never bound by the store (it writes 0/1). */
function toSqlValue(v: unknown): SQLInputValue {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  throw new GwsError("GWS_INTERNAL", `unsupported SQL parameter type: ${typeof v}`);
}

function d1Compatible(db: DatabaseSync, prepared: (sql: string) => StatementSync) {
  return {
    prepare: (sql: string) => new SqliteStatement(prepared, sql),
    async batch(statements: readonly unknown[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
      return inTransaction(db, () =>
        statements.map((s) => {
          if (!(s instanceof SqliteStatement)) throw new GwsError("GWS_INTERNAL", "batch takes statements of this database only");
          return s.runSync();
        }),
      );
    },
  };
}

// ---- Access-token cache ---------------------------------------------------------------------------------

/** Same lifetimes as the remote cache (src/store/token-cache.ts). */
const MIN_TTL_S = 60;
const MAX_TTL_S = 3300;
const EARLY_EXPIRY_S = 300;
const SAFETY_S = 60;

const CachePlain = z.object({ t: z.string().min(1), exp: z.number(), g: z.string().min(1) });

interface TokenCacheDeps {
  accounts: Store["accounts"];
  key: () => Promise<CryptoKey>;
  oauth: Pick<GoogleOAuth, "refresh">;
  redactor: Redactor;
  now: () => number;
}

/**
 * Access tokens in process memory only, each sealed with AES-GCM under the token key with the remote cache's AAD
 * (purpose, key version, user, account) and bound to the account's token generation; nothing is written to disk.
 * The store stays the authority: an account that is not active fails with GWS_RECONNECT_REQUIRED even on a hit,
 * and a revoked grant marks the account `reconnect`. Every token loaded or minted is remembered for redaction.
 */
function createTokenCache(deps: TokenCacheDeps): TokenCache {
  const entries = new Map<string, { userId: string; sealed: Sealed }>();
  const aad = (userId: string, accountId: string) => tokenAad("access", { userId, accountId, keyVersion: KEY_VERSION });

  async function read(key: CryptoKey, userId: string, accountId: string, generation: string): Promise<string | undefined> {
    const e = entries.get(accountId);
    if (e === undefined || e.userId !== userId) return undefined;
    try {
      const entry = CachePlain.parse(JSON.parse(await decrypt(key, e.sealed, aad(userId, accountId))));
      if (entry.exp > deps.now() && entry.g === generation) return entry.t;
    } catch {
      // A foreign or tampered entry is a miss; the refresh below replaces it.
    }
    entries.delete(accountId);
    return undefined;
  }

  return {
    async getAccessToken(account) {
      const generation = account.tokenGeneration;
      if (account.status !== "active" || generation === null) {
        throw new GwsError("GWS_RECONNECT_REQUIRED", "this account must be reconnected", { account: account.email });
      }
      const key = await deps.key();
      const cached = await read(key, account.userId, account.id, generation);
      if (cached !== undefined) {
        deps.redactor.remember(cached);
        return cached;
      }
      const refreshToken = await deps.accounts.getRefreshToken(account.userId, account.id);
      deps.redactor.remember(refreshToken);
      let tokens;
      try {
        tokens = await deps.oauth.refresh(refreshToken);
      } catch (e) {
        if (isGwsError(e) && e.code === "GWS_RECONNECT_REQUIRED") {
          entries.delete(account.id);
          await deps.accounts.markStatus(account.userId, account.id, "reconnect");
        }
        throw e;
      }
      deps.redactor.remember(tokens.accessToken);
      const usable = tokens.expiresIn - SAFETY_S;
      if (usable > 0) {
        const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, tokens.expiresIn - EARLY_EXPIRY_S));
        const plain = JSON.stringify({ t: tokens.accessToken, exp: deps.now() + Math.min(ttl, usable) * 1000, g: generation });
        entries.set(account.id, { userId: account.userId, sealed: await encrypt(key, plain, aad(account.userId, account.id)) });
      }
      return tokens.accessToken;
    },
    async invalidate(accountId) {
      entries.delete(accountId);
    },
  };
}

// ---- The store ------------------------------------------------------------------------------------------

export interface OpenLocalStoreOptions {
  /** The config directory. It is created (mode 700) or checked and repaired here. */
  dir: string;
  /**
   * The upstream of the config this store serves. A new database records it; an existing one must match, so the
   * refresh tokens Google issued are never sent to a fake (or fake tokens to Google).
   */
  upstream: Config["GOOGLE_UPSTREAM"];
  /** Holds TOKEN_ENC_KEY, which seals the refresh tokens and cached access tokens. */
  secrets: SecretSource;
  redactor: Redactor;
  now?: () => number;
}

export interface LocalStore {
  readonly path: string;
  /** The upstream this database belongs to. */
  readonly upstream: Config["GOOGLE_UPSTREAM"];
  /** What opening found at the directory, the database file and any SQLite sidecar files, for `doctor`. */
  readonly checks: readonly PathCheck[];
  readonly schemaVersion: number;
  /**
   * The remote account repository (src/store/db.ts) over this database. The status-blind refresh-token read is
   * only for `revokeAndWipe`, like remote.
   */
  readonly accounts: Store["accounts"];
  readonly links: LinkStore;
  readonly audit: AuditSink;
  readonly rate: RateCounter;
  /** The local user's encrypted settings (the remote settings store over this database). */
  readonly settings: UserSettingsStore;
  /** The access-token cache, refreshing through `oauth` (which must target the same upstream as the session). */
  readonly tokenCache: (oauth: Pick<GoogleOAuth, "refresh">) => TokenCache;
  readonly close: () => void;
}

const LinkKey = z.string().min(1).max(256);
const LinkValue = z.string().max(65536);
const LinkTtl = z.number().int().positive().max(30 * 24 * 3600);

function invalidLink(what: string): GwsError {
  return new GwsError("GWS_INTERNAL", `invalid link record ${what}`);
}

/**
 * Opens the local database under `dir`: the directory must be ours with mode 700 and the file ours with mode 600
 * (each is created that way, repaired when ours with another mode, or refused); pending migrations are applied.
 */
export function openLocalStore(opts: OpenLocalStoreOptions): LocalStore {
  const now = opts.now ?? Date.now;
  const checks: PathCheck[] = [ensurePrivateDir(opts.dir)];
  const file = path.join(opts.dir, DB_FILE);
  const fileCheck = ensurePrivateFile(file, { create: true });
  if (fileCheck === undefined) throw new GwsError("GWS_INTERNAL", `the database file ${file} could not be created`);
  checks.push(fileCheck);
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = ensurePrivateFile(`${file}${suffix}`, { create: false });
    if (sidecar !== undefined) checks.push(sidecar);
  }

  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  let schemaVersion: number;
  try {
    // A pragma, not the open option: the option exists only from Node 22.16, and the package supports 22.13.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL lets `serve` read while the CLI writes. SQLite creates its sidecars with the database file's mode (600).
    db.exec("PRAGMA journal_mode = WAL");
    // Deleted rows (wiped token ciphertext) are overwritten on disk, not left in free pages.
    db.exec("PRAGMA secure_delete = ON");
    schemaVersion = migrate(db);
    bindUpstream(db, opts.upstream);
  } catch (e) {
    db.close();
    throw e;
  }

  const statements = new Map<string, StatementSync>();
  const prepared = (sql: string): StatementSync => {
    let s = statements.get(sql);
    if (s === undefined) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };

  const env: StoreEnv = {
    // openStore reads only prepare/bind/first/all/run/batch, all implemented above; the rest of the D1 API is unused.
    DB: d1Compatible(db, prepared) as unknown as StoreEnv["DB"],
    // Read on each use, so a key set after opening (first setup) is seen.
    get TOKEN_ENC_KEY() {
      return opts.secrets.get("TOKEN_ENC_KEY") ?? "";
    },
  };
  const remote = openStore(env);

  const links: LinkStore = {
    async get(key) {
      const k = LinkKey.safeParse(key);
      if (!k.success) return null;
      const row = prepared("SELECT value FROM links WHERE key = ? AND expires_at > ?").get(k.data, now()) as { value?: unknown } | undefined;
      return typeof row?.value === "string" ? row.value : null;
    },
    async put(key, value, { expirationTtl }) {
      const k = LinkKey.safeParse(key);
      const v = LinkValue.safeParse(value);
      const ttl = LinkTtl.safeParse(expirationTtl);
      if (!k.success) throw invalidLink("key");
      if (!v.success) throw invalidLink("value");
      if (!ttl.success) throw invalidLink("lifetime");
      const at = now();
      inTransaction(db, () => {
        prepared("DELETE FROM links WHERE expires_at <= ?").run(at);
        prepared(
          "INSERT INTO links (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        ).run(k.data, v.data, at + ttl.data * 1000);
      });
    },
    /**
     * Atomic with the `get` before it: the row goes in one `DELETE … RETURNING`, and a delete that removes nothing
     * rejects. So when two callers race to take one link, both may read it, but only the first delete succeeds and
     * the other gets an error instead of the record: a link is taken at most once.
     */
    async delete(key) {
      const k = LinkKey.safeParse(key);
      const row = k.success ? prepared("DELETE FROM links WHERE key = ? RETURNING key").get(k.data) : undefined;
      if (row === undefined) throw new GwsError("GWS_INVALID_INPUT", "this link was already used or has expired");
    },
  };

  // Old fixed windows are never read again; drop them on open (bounded, like the remote prune).
  void remote.rate.prune(now() - 3_600_000, 1000).catch(() => undefined);

  return {
    path: file,
    upstream: opts.upstream,
    checks,
    schemaVersion,
    accounts: remote.accounts,
    links,
    audit: { insertMany: remote.audit.insertMany },
    rate: { hit: remote.rate.hit },
    settings: openUserSettings(env),
    tokenCache: (oauth) =>
      createTokenCache({ accounts: remote.accounts, key: () => importKey(env), oauth, redactor: opts.redactor, now }),
    close: () => db.close(),
  };
}

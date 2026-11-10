import { z } from "zod";
import type { AuditRow } from "../contracts";
import { reconnectRequired } from "../core/accounts-capability";
import type { Account, AccountStatus } from "../core/ports";
import { GwsError } from "../errors";
import { KEY_VERSION, decrypt, encrypt, importKey, tokenAad } from "./crypto";

/** The account types are the core's (the AccountStore port); re-exported here for the store's callers. */
export type { Account, AccountStatus };
export { reconnectRequired };

export interface User {
  id: string;
  primaryEmail: string;
  createdAt: number;
}

/** The latest recorded approval of an MCP client by a user. */
export interface ClientApproval {
  clientId: string;
  /** As sanitized for display at consent; still needs HTML escaping. */
  clientName: string;
  /** Epoch milliseconds. */
  approvedAt: number;
}

export interface UpsertConnectedInput {
  userId: string;
  email: string;
  sub: string;
  scopes: readonly string[];
  /** Absent on a re-consent without prompt=consent: the stored token is kept. */
  refreshToken?: string;
}

/**
 * The store needs the token key, so the secret-stripped `HostEnv` does not type-check here: host fns
 * reach the store only through a capability the dispatcher builds from the full env.
 */
export type StoreEnv = { readonly DB: D1Database; readonly TOKEN_ENC_KEY: string };

interface AccountRow {
  id: string;
  user_id: string;
  email: string;
  google_sub: string;
  alias: string | null;
  is_default: number;
  scopes: string;
  status: AccountStatus;
  refresh_ct: string | null;
  refresh_iv: string | null;
  key_version: number;
  created_at: number;
  updated_at: number;
}

interface UserRow {
  id: string;
  primary_email: string;
  created_at: number;
}

const MAX_REF_ECHO = 320;

const Email = z
  .string()
  .trim()
  .toLowerCase()
  .refine((e) => e.length <= 320 && e.indexOf("@") > 0, "email");
const Sub = z.string().min(1).max(255);
const Id = z.string().min(1).max(256);
const Scope = z.string().min(1).max(256).regex(/^\S+$/);
const AliasValue = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^@\p{Cc}]{1,64}$/u);

const UpsertSchema = z.object({
  userId: Id,
  email: Email,
  sub: Sub,
  scopes: z.array(Scope).max(200),
  refreshToken: z.string().min(1).max(4096).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? what)))].sort();
    throw new GwsError("GWS_INVALID_INPUT", `invalid ${what}: ${fields.join(", ")}`, { details: { fields } });
  }
  return r.data;
}

function splitScopes(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

function joinScopes(scopes: Iterable<string>): string {
  return [...new Set(scopes)].sort().join(" ");
}

function toAccount(r: AccountRow): Account {
  const a: Account = {
    id: r.id,
    userId: r.user_id,
    email: r.email,
    sub: r.google_sub,
    isDefault: r.is_default === 1,
    scopes: splitScopes(r.scopes),
    status: r.status,
    hasRefreshToken: r.refresh_ct !== null,
    tokenGeneration: r.refresh_ct === null ? null : r.refresh_iv,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.alias !== null) a.alias = r.alias;
  return a;
}

function constraintFailure(e: unknown): string | undefined {
  const m = e instanceof Error ? /(UNIQUE|FOREIGN KEY) constraint failed(?::\s*([\w.]+))?/i.exec(e.message) : null;
  return m ? `${m[1]?.toUpperCase()}${m[2] ? ` ${m[2]}` : ""}` : undefined;
}

function unknownAccount(ref?: string): GwsError {
  return new GwsError("GWS_ACCOUNT_UNKNOWN", "no such connected account", ref ? { account: ref.slice(0, MAX_REF_ECHO) } : {});
}

function taken(): GwsError {
  return new GwsError("GWS_ACCOUNT_TAKEN", "this Google account is already connected to another user");
}

const ACCOUNT_COLUMNS =
  "id, user_id, email, google_sub, alias, is_default, scopes, status, refresh_ct, refresh_iv, key_version, created_at, updated_at";

/** Typed repositories over D1. Prepared statements only; only this module and token-cache touch ciphertext. */
export function openStore(env: StoreEnv) {
  const db = env.DB;

  const accountWhere = (where: string, ...binds: unknown[]) =>
    db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE ${where}`)
      .bind(...binds)
      .first<AccountRow>();

  const rowFor = (userId: string, accountId: string) => accountWhere("id = ? AND user_id = ?", accountId, userId);

  async function mustRow(userId: string, accountId: string): Promise<AccountRow> {
    const row = await rowFor(userId, accountId);
    if (!row) throw unknownAccount();
    return row;
  }

  /** Decrypts a row's refresh token; the AAD binds the ciphertext to this user, account and key version. */
  async function decryptRefresh(row: AccountRow & { refresh_ct: string; refresh_iv: string }): Promise<string> {
    if (row.key_version !== KEY_VERSION) throw new GwsError("GWS_INTERNAL", "stored token uses an unsupported key version");
    return decrypt(
      await importKey(env),
      { ct: row.refresh_ct, iv: row.refresh_iv },
      tokenAad("refresh", { userId: row.user_id, accountId: row.id, keyVersion: row.key_version }),
    );
  }

  const users = {
    async findById(id: string): Promise<User | null> {
      const r = await db.prepare("SELECT id, primary_email, created_at FROM users WHERE id = ?").bind(id).first<UserRow>();
      return r ? { id: r.id, primaryEmail: r.primary_email, createdAt: r.created_at } : null;
    },

    /** Creates the user `u_<sub>`, or returns it when it already exists. */
    async create(input: { sub: string; email: string }): Promise<User> {
      const { sub, email } = parse(z.object({ sub: Sub, email: Email }), input, "user");
      const id = `u_${sub}`;
      try {
        await db
          .prepare("INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
          .bind(id, email, Date.now())
          .run();
      } catch (e) {
        if (constraintFailure(e)?.startsWith("UNIQUE")) throw taken();
        throw e;
      }
      const user = await users.findById(id);
      if (!user) throw new GwsError("GWS_INTERNAL", "user creation failed");
      return user;
    },
  };

  const accounts = {
    /**
     * Global lookup by Google sub: sign-in resolves the owning user with it. There is deliberately no
     * lookup by email: a reissued address carries a new sub and must never inherit the old owner's user.
     */
    async findBySub(sub: string): Promise<Account | null> {
      const r = await accountWhere("google_sub = ?", parse(Sub, sub, "sub"));
      return r ? toAccount(r) : null;
    },

    /**
     * True when any account of any user, whatever its status, holds this email. A refusal check for sign-in
     * only: it answers yes or no and never returns the account or its user.
     */
    async emailInUse(email: string): Promise<boolean> {
      const r = await db.prepare("SELECT 1 AS used FROM accounts WHERE email = ? LIMIT 1").bind(parse(Email, email, "email")).first<{ used: number }>();
      return r !== null;
    },

    async listForUser(userId: string): Promise<Account[]> {
      const { results } = await db
        .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE user_id = ? ORDER BY created_at, email`)
        .bind(userId)
        .all<AccountRow>();
      return results.map(toAccount);
    },

    async get(userId: string, accountId: string): Promise<Account | null> {
      const r = await rowFor(userId, accountId);
      return r ? toAccount(r) : null;
    },

    /**
     * Resolves an email or alias among the user's own accounts, or the default when `ref` is empty.
     * Another user's account is indistinguishable from an unknown one.
     */
    async resolve(userId: string, ref?: string): Promise<Account> {
      const r = ref?.trim() ?? "";
      let row: AccountRow | null;
      if (r === "") {
        row = await accountWhere("user_id = ? AND is_default = 1", userId);
        if (!row) throw new GwsError("GWS_NO_DEFAULT_ACCOUNT", "no default account is set; pass account explicitly");
      } else {
        row = await accountWhere(r.includes("@") ? "user_id = ? AND email = ?" : "user_id = ? AND alias = ?", userId, r.toLowerCase());
        if (!row) throw unknownAccount(r);
      }
      if (row.status !== "active") throw reconnectRequired(row);
      return toAccount(row);
    },

    /**
     * Stores a Google consent result. Identity is the Google sub: a sub owned by another user, or an
     * email held by another Google identity, fails with GWS_ACCOUNT_TAKEN. `scopes` must be the set the
     * token response granted (with include_granted_scopes=true, Google returns the whole grant); it
     * replaces the stored set, with no local merge. A missing refresh token keeps the stored one.
     * Only a fresh refresh token activates an account: a re-consent without one leaves a `reconnect`
     * account in `reconnect`, because its stored token is known to be dead.
     * A consent that moves a `disconnected` account out of that state (to `active`, or to `reconnect` when
     * Google returns no token) also deletes the account from every client allowlist, so reconnecting never
     * restores a client's access: only a human grant on /connections does. The delete and the status update
     * run in one batch (one transaction), and "was disconnected" is decided by SQL inside it, never from the
     * read above, so a disconnect that lands in between still clears. Rows of an `active` or `reconnect`
     * account are kept: only a gws-mcp disconnect means "forget the clients".
     * A user's first default-less account becomes the default.
     */
    async upsertConnected(input: UpsertConnectedInput): Promise<Account> {
      const p = parse(UpsertSchema, input, "account");
      const bySub = await accountWhere("google_sub = ?", p.sub);
      if (bySub && bySub.user_id !== p.userId) throw taken();
      const byEmail = await accountWhere("email = ?", p.email);
      if (byEmail && byEmail.google_sub !== p.sub) throw taken();

      const id = bySub?.id ?? `a_${crypto.randomUUID()}`;
      const sealed =
        p.refreshToken === undefined
          ? undefined
          : await encrypt(
              await importKey(env),
              p.refreshToken,
              tokenAad("refresh", { userId: p.userId, accountId: id, keyVersion: KEY_VERSION }),
            );
      const now = Date.now();
      try {
        if (bySub) {
          await db.batch([
            db
              .prepare(
                `DELETE FROM client_grants WHERE user_id = ? AND account_id = ?
                   AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND status = 'disconnected')`,
              )
              .bind(p.userId, id, id, p.userId),
            db
              .prepare(
                `UPDATE accounts SET email = ?, scopes = ?,
                 refresh_ct = COALESCE(?, refresh_ct), refresh_iv = COALESCE(?, refresh_iv),
                 key_version = CASE WHEN ? IS NULL THEN key_version ELSE ? END,
                 status = CASE WHEN ? IS NOT NULL THEN 'active'
                               WHEN status = 'active' AND refresh_ct IS NOT NULL THEN 'active'
                               ELSE 'reconnect' END,
                 updated_at = ?
               WHERE id = ? AND user_id = ? AND google_sub = ?`,
              )
              .bind(
                p.email,
                joinScopes(p.scopes),
                sealed?.ct ?? null,
                sealed?.iv ?? null,
                sealed?.ct ?? null,
                KEY_VERSION,
                sealed?.ct ?? null,
                now,
                id,
                p.userId,
                p.sub,
              ),
          ]);
        } else {
          await db
            .prepare(
              `INSERT INTO accounts (${ACCOUNT_COLUMNS})
               VALUES (?, ?, ?, ?, NULL,
                 CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE user_id = ? AND is_default = 1) THEN 0 ELSE 1 END,
                 ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              id,
              p.userId,
              p.email,
              p.sub,
              p.userId,
              joinScopes(p.scopes),
              sealed ? "active" : "reconnect",
              sealed?.ct ?? null,
              sealed?.iv ?? null,
              KEY_VERSION,
              now,
              now,
            )
            .run();
        }
      } catch (e) {
        const c = constraintFailure(e);
        if (c === "UNIQUE accounts.email" || c === "UNIQUE accounts.google_sub") throw taken();
        if (c?.startsWith("FOREIGN KEY")) throw new GwsError("GWS_INTERNAL", "account owner does not exist");
        throw e;
      }
      return toAccount(await mustRow(p.userId, id));
    },

    async setDefault(userId: string, accountId: string): Promise<Account> {
      await mustRow(userId, accountId);
      const now = Date.now();
      // Clear first: the partial unique index allows one default per user at every statement.
      await db.batch([
        db
          .prepare("UPDATE accounts SET is_default = 0, updated_at = ? WHERE user_id = ? AND is_default = 1 AND id <> ?")
          .bind(now, userId, accountId),
        db.prepare("UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?").bind(now, accountId, userId),
      ]);
      return toAccount(await mustRow(userId, accountId));
    },

    /** Sets or clears (null) an alias. Aliases are lowercased, unique per user and never contain "@". */
    async setAlias(userId: string, accountId: string, alias: string | null): Promise<Account> {
      const value = alias === null ? null : parse(AliasValue, alias, "alias");
      await mustRow(userId, accountId);
      try {
        await db
          .prepare("UPDATE accounts SET alias = ?, updated_at = ? WHERE id = ? AND user_id = ?")
          .bind(value, Date.now(), accountId, userId)
          .run();
      } catch (e) {
        // By design (accepted), this tells an SDK client that an alias label exists on another of the user's
        // accounts, even one it may not use. It reveals the label only: never which account, nor its email.
        if (constraintFailure(e)?.startsWith("UNIQUE")) {
          throw new GwsError("GWS_INVALID_INPUT", "alias is already used by another of your accounts", { details: { fields: ["alias"] } });
        }
        throw e;
      }
      return toAccount(await mustRow(userId, accountId));
    },

    /**
     * Marks an account for reconnection, or back to active (only while it still holds a token).
     * A disconnected account stays disconnected: only a new consent (`upsertConnected`) revives it.
     */
    async markStatus(userId: string, accountId: string, status: "active" | "reconnect"): Promise<Account> {
      const res = await db
        .prepare(
          `UPDATE accounts SET status = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status <> 'disconnected' AND (? <> 'active' OR refresh_ct IS NOT NULL)`,
        )
        .bind(status, Date.now(), accountId, userId, status)
        .run();
      const row = await mustRow(userId, accountId);
      if (res.meta.changes === 0 && !(status === "reconnect" && row.status === "disconnected")) {
        throw new GwsError("GWS_RECONNECT_REQUIRED", "this account holds no token and must be reconnected", { account: row.email });
      }
      return toAccount(row);
    },

    /**
     * Disconnects an account: deletes the stored refresh token and the scopes and marks it `disconnected`.
     * Client allowlist rows are KEPT, so an allowlisted client's next call gets GWS_RECONNECT_REQUIRED
     * (others still get the uniform denial); the consent that brings the account back clears them
     * (`upsertConnected`), so reconnecting restores no client's access.
     */
    async wipeToken(userId: string, accountId: string): Promise<Account> {
      const res = await db
        .prepare(
          `UPDATE accounts SET refresh_ct = NULL, refresh_iv = NULL, scopes = '', status = 'disconnected', updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .bind(Date.now(), accountId, userId)
        .run();
      if (res.meta.changes === 0) throw unknownAccount();
      return toAccount(await mustRow(userId, accountId));
    },

    /**
     * Decrypts the stored refresh token of an active account. Host-internal: the token cache and the
     * disconnect flow use it; the plaintext never leaves the host or reaches a log or error.
     */
    async getRefreshToken(userId: string, accountId: string): Promise<string> {
      const row = await mustRow(userId, accountId);
      if (row.status !== "active" || row.refresh_ct === null || row.refresh_iv === null) {
        throw new GwsError("GWS_RECONNECT_REQUIRED", "this account must be reconnected", { account: row.email });
      }
      return decryptRefresh({ ...row, refresh_ct: row.refresh_ct, refresh_iv: row.refresh_iv });
    },

    /**
     * Decrypts the stored refresh token whatever the account's status, or returns null when none is stored.
     * Only the disconnect flow may use it, to revoke the Google grant of an account in reconnect state too;
     * every other caller must use `getRefreshToken`, which serves active accounts only.
     */
    async getRefreshTokenForRevoke(userId: string, accountId: string): Promise<string | null> {
      const row = await mustRow(userId, accountId);
      if (row.refresh_ct === null || row.refresh_iv === null) return null;
      return decryptRefresh({ ...row, refresh_ct: row.refresh_ct, refresh_iv: row.refresh_iv });
    },
  };

  function grantFailure(e: unknown): never {
    if (constraintFailure(e)?.startsWith("FOREIGN KEY")) throw unknownAccount();
    throw e;
  }

  const ClientId = z.string().min(1).max(256);

  const grants = {
    async list(userId: string, clientId: string): Promise<string[]> {
      const { results } = await db
        .prepare("SELECT account_id FROM client_grants WHERE user_id = ? AND client_id = ? ORDER BY account_id")
        .bind(userId, clientId)
        .all<{ account_id: string }>();
      return results.map((r) => r.account_id);
    },

    async isAllowed(userId: string, clientId: string, accountId: string): Promise<boolean> {
      const r = await db
        .prepare("SELECT 1 AS ok FROM client_grants WHERE user_id = ? AND client_id = ? AND account_id = ?")
        .bind(userId, clientId, accountId)
        .first<{ ok: number }>();
      return r !== null;
    },

    /** Sets the client's allowlist to exactly `accountIds`, atomically. Any foreign id fails the whole change. */
    async replace(userId: string, clientId: string, accountIds: readonly string[]): Promise<void> {
      const client = parse(ClientId, clientId, "client id");
      const ids = [...new Set(parse(z.array(Id).max(100), accountIds, "account ids"))];
      const now = Date.now();
      try {
        await db.batch([
          db.prepare("DELETE FROM client_grants WHERE user_id = ? AND client_id = ?").bind(userId, client),
          ...ids.map((id) =>
            db
              .prepare("INSERT INTO client_grants (user_id, client_id, account_id, created_at) VALUES (?, ?, ?, ?)")
              .bind(userId, client, id, now),
          ),
        ]);
      } catch (e) {
        grantFailure(e);
      }
    },

    async add(userId: string, clientId: string, accountId: string): Promise<void> {
      const client = parse(ClientId, clientId, "client id");
      try {
        await db
          .prepare(
            "INSERT INTO client_grants (user_id, client_id, account_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
          )
          .bind(userId, client, parse(Id, accountId, "account id"), Date.now())
          .run();
      } catch (e) {
        grantFailure(e);
      }
    },

    async remove(userId: string, clientId: string, accountId: string): Promise<void> {
      await db
        .prepare("DELETE FROM client_grants WHERE user_id = ? AND client_id = ? AND account_id = ?")
        .bind(userId, clientId, accountId)
        .run();
    },

    async removeClient(userId: string, clientId: string): Promise<void> {
      await db.prepare("DELETE FROM client_grants WHERE user_id = ? AND client_id = ?").bind(userId, clientId).run();
    },
  };

  /** OAuth provider grant ids: the provider's own alphabet (letters, digits, `-`, `_`). */
  const GrantId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
  const ApprovalInput = z.object({ userId: Id, clientId: ClientId, grantId: GrantId, clientName: z.string().min(1).max(256) });

  /** The latest approval of each of the user's clients (of one client when `clientId` is given), by client id. */
  async function latestApprovals(userId: string, clientId?: string): Promise<ClientApproval[]> {
    const { results } = await db
      .prepare(
        `SELECT client_id, client_name, created_at FROM client_approvals WHERE user_id = ?${clientId === undefined ? "" : " AND client_id = ?"}
         ORDER BY client_id, created_at, grant_id`,
      )
      .bind(...(clientId === undefined ? [userId] : [userId, clientId]))
      .all<{ client_id: string; client_name: string; created_at: number }>();
    const latest = new Map<string, ClientApproval>();
    for (const r of results) latest.set(r.client_id, { clientId: r.client_id, clientName: r.client_name, approvedAt: r.created_at });
    return [...latest.values()];
  }

  /**
   * MCP client approvals recorded at consent, one row per OAuth grant. D1 is strongly consistent, unlike the
   * provider's grant listing (a KV list), so these rows decide which clients a user approved and which grant
   * ids a revoke must revoke.
   */
  const approvals = {
    async record(input: { userId: string; clientId: string; grantId: string; clientName: string }): Promise<void> {
      const r = parse(ApprovalInput, input, "client approval");
      await db
        .prepare("INSERT INTO client_approvals (user_id, client_id, grant_id, client_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(r.userId, r.clientId, r.grantId, r.clientName, Date.now())
        .run();
    },

    /** Whether the grant `grantId` is recorded for exactly this user and client. */
    async has(userId: string, clientId: string, grantId: string): Promise<boolean> {
      const r = await db
        .prepare("SELECT 1 AS ok FROM client_approvals WHERE user_id = ? AND client_id = ? AND grant_id = ?")
        .bind(userId, clientId, grantId)
        .first<{ ok: number }>();
      return r !== null;
    },

    /** Every recorded grant id of the user's client. */
    async grantIds(userId: string, clientId: string): Promise<string[]> {
      const { results } = await db
        .prepare("SELECT grant_id FROM client_approvals WHERE user_id = ? AND client_id = ? ORDER BY created_at, grant_id")
        .bind(userId, clientId)
        .all<{ grant_id: string }>();
      return results.map((r) => r.grant_id);
    },

    /** The user's approved clients, each with the name and time of its latest approval. */
    list(userId: string): Promise<ClientApproval[]> {
      return latestApprovals(userId);
    },

    /** The user's approved client `clientId`, or null when the user holds no approval of it. */
    async get(userId: string, clientId: string): Promise<ClientApproval | null> {
      return (await latestApprovals(userId, clientId))[0] ?? null;
    },

    /** Deletes exactly the given grants' rows (rows added meanwhile by a new consent stay). */
    async remove(userId: string, clientId: string, grantIds: readonly string[]): Promise<void> {
      if (grantIds.length === 0) return;
      const stmt = db.prepare("DELETE FROM client_approvals WHERE user_id = ? AND client_id = ? AND grant_id = ?");
      await db.batch(grantIds.map((id) => stmt.bind(userId, clientId, id)));
    },
  };

  const audit = {
    /** Writes all rows in one batch (one transaction). */
    async insertMany(rows: readonly AuditRow[]): Promise<void> {
      if (rows.length === 0) return;
      const stmt = db.prepare(
        `INSERT INTO audit_log (id, ts, execute_id, user_id, client_id, account_id, fn, effect, applied, status, code,
           duration_ms, request_id, upstream_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      await db.batch(
        rows.map((r) =>
          stmt.bind(
            r.id,
            r.ts,
            r.execute_id,
            r.user_id,
            r.client_id,
            r.account_id,
            r.fn,
            r.effect,
            r.applied,
            r.status,
            r.code,
            r.duration_ms,
            r.request_id,
            r.upstream_status,
          ),
        ),
      );
    },
  };

  const rate = {
    /** Counts one hit in the fixed window and returns the window's new count. */
    async hit(key: string, windowStart: number): Promise<number> {
      const k = parse(z.string().min(1).max(256), key, "rate key");
      const w = parse(z.number().int().nonnegative(), windowStart, "rate window");
      const r = await db
        .prepare(
          `INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
        )
        .bind(k, w)
        .first<{ count: number }>();
      if (!r) throw new GwsError("GWS_INTERNAL", "rate counter update returned no row");
      return r.count;
    },

    /** The window's count so far (0 when nothing was counted). Reads only, so a refusal can answer without a write. */
    async count(key: string, windowStart: number): Promise<number> {
      const k = parse(z.string().min(1).max(256), key, "rate key");
      const w = parse(z.number().int().nonnegative(), windowStart, "rate window");
      const r = await db
        .prepare("SELECT count FROM rate_counters WHERE key = ? AND window_start = ?")
        .bind(k, w)
        .first<{ count: number }>();
      return r?.count ?? 0;
    },

    /** Deletes at most `max` counter rows of windows that started before `before`; returns how many went. */
    async prune(before: number, max: number): Promise<number> {
      const b = parse(z.number().int(), before, "rate prune bound");
      const m = parse(z.number().int().min(1).max(1000), max, "rate prune batch");
      const r = await db
        .prepare("DELETE FROM rate_counters WHERE rowid IN (SELECT rowid FROM rate_counters WHERE window_start < ? LIMIT ?)")
        .bind(b, m)
        .run();
      return r.meta.changes;
    },
  };

  return { users, accounts, grants, approvals, audit, rate };
}

export type Store = ReturnType<typeof openStore>;

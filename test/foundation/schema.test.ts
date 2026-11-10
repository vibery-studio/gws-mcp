import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const TABLES = ["users", "accounts", "client_grants", "client_approvals", "audit_log", "rate_counters"] as const;
const ALLOWED_SENSITIVE = new Set(["refresh_ct", "refresh_iv"]);

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("D1 schema", () => {
  it.each(TABLES)("table %s exists", async (table) => {
    expect((await columns(table)).length).toBeGreaterThan(0);
  });

  it("has no body, content, token or raw columns apart from the encrypted refresh pair", async () => {
    for (const table of TABLES) {
      for (const col of await columns(table)) {
        if (ALLOWED_SENSITIVE.has(col)) continue;
        expect(col, `${table}.${col}`).not.toMatch(/body|content|token|raw/i);
      }
    }
  });

  it("audit_log holds metadata columns only", async () => {
    expect((await columns("audit_log")).sort()).toEqual(
      [
        "id",
        "ts",
        "execute_id",
        "user_id",
        "client_id",
        "account_id",
        "fn",
        "effect",
        "applied",
        "status",
        "code",
        "duration_ms",
        "request_id",
        "upstream_status",
      ].sort(),
    );
  });

  it("allows only one default account per user", async () => {
    const now = Date.now();
    const user = `u_schema_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?)")
      .bind(user, `${user}@fake.test`, now)
      .run();
    const insertAccount = (id: string, isDefault: number) =>
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, email, google_sub, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, user, `${id}@fake.test`, `sub-${id}`, isDefault, now, now)
        .run();
    await insertAccount(`${user}-a`, 1);
    await insertAccount(`${user}-b`, 0);
    await expect(insertAccount(`${user}-c`, 1)).rejects.toThrow(/UNIQUE/i);
  });

  it("rejects an unknown account status", async () => {
    const now = Date.now();
    const user = `u_status_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?)")
      .bind(user, `${user}@fake.test`, now)
      .run();
    await expect(
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, email, google_sub, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'paused', ?, ?)",
      )
        .bind(`${user}-a`, user, `${user}-a@fake.test`, `sub-${user}`, now, now)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });
});

interface AccountRow {
  id: string;
  user_id: string;
  email: string;
  google_sub: string | null;
  alias: string | null;
  status: string;
  refresh_ct: string | null;
  refresh_iv: string | null;
}

async function newUser(prefix: string): Promise<string> {
  const id = `u_${prefix}_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?)")
    .bind(id, `${id}@fake.test`, Date.now())
    .run();
  return id;
}

function insertAccount(userId: string, patch: Partial<AccountRow> = {}) {
  const id = patch.id ?? `acc_${crypto.randomUUID()}`;
  const row: AccountRow = {
    id,
    user_id: userId,
    email: `${id}@fake.test`,
    google_sub: `sub-${id}`,
    alias: null,
    status: "active",
    refresh_ct: null,
    refresh_iv: null,
    ...patch,
  };
  const now = Date.now();
  return {
    row,
    run: () =>
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, email, google_sub, alias, status, refresh_ct, refresh_iv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(row.id, row.user_id, row.email, row.google_sub, row.alias, row.status, row.refresh_ct, row.refresh_iv, now, now)
        .run(),
  };
}

function insertGrant(userId: string, accountId: string) {
  return env.DB.prepare("INSERT INTO client_grants (user_id, client_id, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, `client-${crypto.randomUUID()}`, accountId, Date.now())
    .run();
}

async function grantCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM client_grants WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

describe("client grants stay within one user", () => {
  it("accepts a grant on the user's own account", async () => {
    const user = await newUser("grant_own");
    const acc = insertAccount(user);
    await acc.run();
    await insertGrant(user, acc.row.id);
    expect(await grantCount(acc.row.id)).toBe(1);
  });

  it("rejects a grant that points at another user's account", async () => {
    const owner = await newUser("grant_owner");
    const intruder = await newUser("grant_intruder");
    const acc = insertAccount(owner);
    await acc.run();
    await expect(insertGrant(intruder, acc.row.id)).rejects.toThrow(/FOREIGN KEY/i);
    expect(await grantCount(acc.row.id)).toBe(0);
  });

  it("deletes the grants when the account is deleted", async () => {
    const user = await newUser("grant_cascade");
    const acc = insertAccount(user);
    await acc.run();
    await insertGrant(user, acc.row.id);
    await insertGrant(user, acc.row.id);
    expect(await grantCount(acc.row.id)).toBe(2);
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(acc.row.id).run();
    expect(await grantCount(acc.row.id)).toBe(0);
  });
});

describe("account identity", () => {
  it.each([
    ["a NULL google_sub", { google_sub: null }, /NOT NULL/i],
    ["an empty google_sub", { google_sub: "" }, /CHECK/i],
  ])("rejects %s", async (_label, patch, error) => {
    const user = await newUser("sub_missing");
    await expect(insertAccount(user, patch).run()).rejects.toThrow(error);
  });

  it("rejects a google_sub already bound to another account", async () => {
    const user = await newUser("sub_dup");
    const sub = `sub-${crypto.randomUUID()}`;
    await insertAccount(user, { google_sub: sub }).run();
    const other = await newUser("sub_dup_other");
    await expect(insertAccount(other, { google_sub: sub }).run()).rejects.toThrow(/UNIQUE/i);
  });

  it("rejects an email without a local part and domain separator", async () => {
    const user = await newUser("email_shape");
    await expect(insertAccount(user, { email: "no-at-sign" }).run()).rejects.toThrow(/CHECK/i);
  });

  it("accepts a short alias", async () => {
    const user = await newUser("alias_ok");
    await insertAccount(user, { alias: "work" }).run();
  });

  it("rejects an alias that equals another account's email", async () => {
    const user = await newUser("alias_email");
    const first = insertAccount(user);
    await first.run();
    await expect(insertAccount(user, { alias: first.row.email }).run()).rejects.toThrow(/CHECK/i);
  });

  it.each([
    ["empty", ""],
    ["longer than 64 characters", "a".repeat(65)],
  ])("rejects an alias that is %s", async (_label, alias) => {
    const user = await newUser("alias_len");
    await expect(insertAccount(user, { alias }).run()).rejects.toThrow(/CHECK/i);
  });
});

describe("encrypted refresh token columns", () => {
  it("accepts ciphertext with its IV on an active account", async () => {
    const user = await newUser("ct_ok");
    await insertAccount(user, { refresh_ct: "ct", refresh_iv: "iv" }).run();
  });

  it.each([
    ["ciphertext without IV", { refresh_ct: "ct" }],
    ["IV without ciphertext", { refresh_iv: "iv" }],
  ])("rejects %s", async (_label, patch) => {
    const user = await newUser("ct_pair");
    await expect(insertAccount(user, patch).run()).rejects.toThrow(/CHECK/i);
  });

  it("rejects a disconnected account that still holds a refresh token", async () => {
    const user = await newUser("ct_disc");
    await expect(
      insertAccount(user, { status: "disconnected", refresh_ct: "ct", refresh_iv: "iv" }).run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it("rejects a disconnect that forgets to clear the refresh token", async () => {
    const user = await newUser("ct_disc_update");
    const acc = insertAccount(user, { refresh_ct: "ct", refresh_iv: "iv" });
    await acc.run();
    await expect(
      env.DB.prepare("UPDATE accounts SET status = 'disconnected' WHERE id = ?").bind(acc.row.id).run(),
    ).rejects.toThrow(/CHECK/i);
    await env.DB.prepare(
      "UPDATE accounts SET status = 'disconnected', refresh_ct = NULL, refresh_iv = NULL WHERE id = ?",
    )
      .bind(acc.row.id)
      .run();
  });
});

describe("audit_log bounds snippet-chosen strings", () => {
  function insertAudit(patch: { fn?: string; code?: string | null; request_id?: string | null }) {
    return env.DB.prepare(
      "INSERT INTO audit_log (id, ts, execute_id, user_id, client_id, account_id, fn, effect, applied, status, code, duration_ms, request_id, upstream_status) VALUES (?, ?, ?, ?, ?, NULL, ?, 'read', 0, 'error', ?, 1, ?, NULL)",
    )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        "exec-1",
        "u_audit",
        "client-1",
        patch.fn ?? "gmail.users.messages.list",
        patch.code === undefined ? "GWS_UPSTREAM_ERROR" : patch.code,
        patch.request_id === undefined ? null : patch.request_id,
      )
      .run();
  }

  it("accepts a normal row", async () => {
    await insertAudit({});
    await insertAudit({ code: null, request_id: "req-123" });
  });

  it.each([
    ["an fn longer than 200 characters", { fn: "x".repeat(201) }],
    ["a free-text code", { code: "anything the snippet wants" }],
    ["free text after the code prefix", { code: "GWS_X leaked text" }],
    ["an over-long code", { code: `GWS_${"X".repeat(64)}` }],
    ["a request_id longer than 200 characters", { request_id: "r".repeat(201) }],
  ])("rejects %s", async (_label, patch) => {
    await expect(insertAudit(patch)).rejects.toThrow(/CHECK/i);
  });
});

describe("client approvals", () => {
  const insertApproval = (userId: string, grantId: string, clientId = "client-1", clientName = "Client") =>
    env.DB.prepare("INSERT INTO client_approvals (user_id, client_id, grant_id, client_name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, clientId, grantId, clientName, Date.now())
      .run();

  it("holds exactly the approval columns", async () => {
    expect((await columns("client_approvals")).sort()).toEqual(["client_id", "client_name", "created_at", "grant_id", "user_id"]);
  });

  it("keeps one row per grant of a user", async () => {
    const user = await newUser("approval");
    await insertApproval(user, "grant-a");
    await insertApproval(user, "grant-b");
    await expect(insertApproval(user, "grant-a", "client-2")).rejects.toThrow(/UNIQUE|PRIMARY/i);
  });

  it("rejects a row for an unknown user", async () => {
    await expect(insertApproval(`u_missing_${crypto.randomUUID()}`, "grant-a")).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rejects an empty client id, grant id or client name", async () => {
    const user = await newUser("approval-empty");
    await expect(insertApproval(user, "")).rejects.toThrow(/CHECK/i);
    await expect(insertApproval(user, "grant-a", "")).rejects.toThrow(/CHECK/i);
    await expect(insertApproval(user, "grant-a", "client-1", "")).rejects.toThrow(/CHECK/i);
  });

  it("is deleted with its user", async () => {
    const user = await newUser("approval-cascade");
    await insertApproval(user, "grant-a");
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user).run();
    const row = await env.DB.prepare("SELECT 1 AS ok FROM client_approvals WHERE user_id = ?").bind(user).first();
    expect(row).toBeNull();
  });

  it("is indexed by user and client", async () => {
    const { results } = await env.DB.prepare("PRAGMA index_list(client_approvals)").all<{ name: string }>();
    const indexed: string[][] = [];
    for (const { name } of results) {
      const cols = await env.DB.prepare(`PRAGMA index_info(${name})`).all<{ name: string }>();
      indexed.push(cols.results.map((c) => c.name));
    }
    expect(indexed).toContainEqual(["user_id", "client_id"]);
  });
});

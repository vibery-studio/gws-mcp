import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AuditRow } from "../../src/contracts";
import { isGwsError } from "../../src/errors";
import { googleOAuth } from "../../src/google/oauth";
import { omitSecrets } from "../../src/runtime/workers/env";
import { openStore } from "../../src/store/db";
import { getAccessToken } from "../../src/store/token-cache";
import { authorizeAtFake, fakeTransport, seedUserWithAccount, stringViews } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";

const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const SHEETS = "https://www.googleapis.com/auth/spreadsheets";

const store = openStore(env);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (!isGwsError(e)) throw e;
    return e.code;
  }
  throw new Error("expected a rejection");
}

function rawSub(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
}

async function accountRow(id: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
  if (!row) throw new Error("row missing");
  return row;
}

describe("users", () => {
  it("creates a user with id u_<sub>, idempotently, and finds it by id", async () => {
    const sub = rawSub();
    const email = uniqueEmail("db-user");
    const user = await store.users.create({ sub, email });
    expect(user.id).toBe(`u_${sub}`);
    expect((await store.users.create({ sub, email })).id).toBe(user.id);
    expect((await store.users.findById(user.id))?.primaryEmail).toBe(email);
    expect(await store.users.findById("u_missing")).toBeNull();
  });

  it("refuses a second user claiming the same primary email", async () => {
    const email = uniqueEmail("db-user-dup");
    await store.users.create({ sub: rawSub(), email });
    expect(await codeOf(store.users.create({ sub: rawSub(), email }))).toBe("GWS_ACCOUNT_TAKEN");
  });
});

describe("accounts.resolve", () => {
  it("resolves by email (case-insensitive), by alias, and falls back to the default", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-res-a"), scopes: [GMAIL_RO], alias: "Work" });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-res-b"), scopes: [DRIVE_FILE], userId: a.userId });
    expect(a.account.isDefault).toBe(true);
    expect(b.account.isDefault).toBe(false);

    expect((await store.accounts.resolve(a.userId, b.account.email.toUpperCase())).id).toBe(b.account.id);
    expect((await store.accounts.resolve(a.userId, "work")).id).toBe(a.account.id);
    expect((await store.accounts.resolve(a.userId, "WORK")).id).toBe(a.account.id);
    expect((await store.accounts.resolve(a.userId)).id).toBe(a.account.id);
    expect((await store.accounts.resolve(a.userId, "")).id).toBe(a.account.id);
  });

  it("fails with GWS_ACCOUNT_UNKNOWN for an unknown ref and for another user's email", async () => {
    const mine = await seedUserWithAccount(env, { email: uniqueEmail("db-res-mine"), scopes: [] });
    const theirs = await seedUserWithAccount(env, { email: uniqueEmail("db-res-theirs"), scopes: [], alias: "home" });
    expect(await codeOf(store.accounts.resolve(mine.userId, "nobody@fake.test"))).toBe("GWS_ACCOUNT_UNKNOWN");
    expect(await codeOf(store.accounts.resolve(mine.userId, "nope"))).toBe("GWS_ACCOUNT_UNKNOWN");
    expect(await codeOf(store.accounts.resolve(mine.userId, theirs.account.email))).toBe("GWS_ACCOUNT_UNKNOWN");
    expect(await codeOf(store.accounts.resolve(mine.userId, "home"))).toBe("GWS_ACCOUNT_UNKNOWN");
  });

  it("fails with GWS_NO_DEFAULT_ACCOUNT when no ref is given and the user has no default", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-nodef"), scopes: [], isDefault: false });
    expect(await codeOf(store.accounts.resolve(s.userId))).toBe("GWS_NO_DEFAULT_ACCOUNT");
    expect((await store.accounts.resolve(s.userId, s.account.email)).id).toBe(s.account.id);
  });

  it("fails with GWS_RECONNECT_REQUIRED for an account that is not active", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-recon"), scopes: [] });
    await store.accounts.markStatus(s.userId, s.account.id, "reconnect");
    expect(await codeOf(store.accounts.resolve(s.userId, s.account.email))).toBe("GWS_RECONNECT_REQUIRED");
    expect(await codeOf(store.accounts.resolve(s.userId))).toBe("GWS_RECONNECT_REQUIRED");
  });
});

describe("sign-in lookup by Google sub", () => {
  it("never resolves a reused email to the user who owned it under another sub", async () => {
    const owner = await seedUserWithAccount(env, { email: uniqueEmail("db-sub-owner"), scopes: [GMAIL_RO] });
    expect((await store.accounts.findBySub(owner.sub))?.userId).toBe(owner.userId);

    // The address is reissued to another person: userinfo returns the same email with a new sub.
    const newcomerSub = rawSub();
    expect(await store.accounts.findBySub(newcomerSub)).toBeNull();
    expect(await codeOf(store.users.create({ sub: newcomerSub, email: owner.account.email }))).toBe("GWS_ACCOUNT_TAKEN");
    const other = await store.users.create({ sub: newcomerSub, email: uniqueEmail("db-sub-newcomer") });
    const claim = { userId: other.id, email: owner.account.email, sub: newcomerSub, scopes: ["openid"], refreshToken: "1//x" };
    expect(await codeOf(store.accounts.upsertConnected(claim))).toBe("GWS_ACCOUNT_TAKEN");
    expect(await store.accounts.findBySub(newcomerSub)).toBeNull();
  });

  it("offers no lookup by email that sign-in could use to pick the owning user", () => {
    expect("findByEmail" in store.accounts).toBe(false);
    // The only email method answers yes or no; it never returns an account or a user.
    expect(Object.keys(store.accounts).filter((k) => /email/i.test(k))).toEqual(["emailInUse"]);
  });

  it("tells whether any user's account holds an email, case-insensitively, as a bare boolean", async () => {
    const owner = await seedUserWithAccount(env, { email: uniqueEmail("db-email-used"), scopes: [GMAIL_RO] });
    expect(await store.accounts.emailInUse(owner.account.email)).toBe(true);
    expect(await store.accounts.emailInUse(`  ${owner.account.email.toUpperCase()} `)).toBe(true);
    expect(await store.accounts.emailInUse(uniqueEmail("db-email-free"))).toBe(false);
  });

  it("still counts an email as in use after its account is disconnected", async () => {
    const owner = await seedUserWithAccount(env, { email: uniqueEmail("db-email-gone"), scopes: [GMAIL_RO] });
    await store.accounts.wipeToken(owner.userId, owner.account.id);
    expect(await store.accounts.emailInUse(owner.account.email)).toBe(true);
  });

  it("refuses a value that is not an email", async () => {
    expect(await codeOf(store.accounts.emailInUse("no-at-sign"))).toBe("GWS_INVALID_INPUT");
  });
});

describe("accounts.upsertConnected", () => {
  it("stores exactly the scope set Google returned, never a union with stale stored scopes", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-scope-exact"), scopes: [GMAIL_RO, DRIVE_FILE] });
    expect(s.account.scopes).toEqual(["email", "openid", DRIVE_FILE, GMAIL_RO].sort());
    const updated = await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, scopes: [GMAIL_RO] });
    expect(updated.scopes).toEqual([GMAIL_RO]);
  });

  it("ends an incremental consent (gmail, then sheets) with both scopes, from Google's granted set", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-incremental"), scopes: [GMAIL_RO] });
    const more = await googleOAuth(env, fakeTransport).exchangeCode(await authorizeAtFake({ email: s.account.email, scopes: [SHEETS] }));
    const updated = await store.accounts.upsertConnected({
      userId: s.userId,
      email: s.account.email,
      sub: s.sub,
      scopes: more.scopes,
      refreshToken: more.refreshToken,
    });
    expect(updated.scopes).toEqual(["email", "openid", GMAIL_RO, SHEETS].sort());
  });

  it("keeps a reconnect account in reconnect when a re-consent brings no new refresh token", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-recon-keep"), scopes: [GMAIL_RO] });
    await store.accounts.markStatus(s.userId, s.account.id, "reconnect");
    const reconsent = await googleOAuth(env, fakeTransport).exchangeCode(
      await authorizeAtFake({ email: s.account.email, scopes: [GMAIL_RO], withoutConsentPrompt: true }),
    );
    expect(reconsent.refreshToken).toBeUndefined();
    const after = await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, scopes: reconsent.scopes });
    expect(after.status).toBe("reconnect");
    expect(await codeOf(store.accounts.resolve(s.userId, s.account.email))).toBe("GWS_RECONNECT_REQUIRED");
  });

  it("keeps the stored refresh token when a re-consent returns none", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-keep"), scopes: [GMAIL_RO] });
    const before = await accountRow(s.account.id);

    const oauth = googleOAuth(env, fakeTransport);
    const reconsent = await oauth.exchangeCode(
      await authorizeAtFake({ email: s.account.email, scopes: [SHEETS], withoutConsentPrompt: true }),
    );
    expect(reconsent.refreshToken).toBeUndefined();

    const kept = await store.accounts.upsertConnected({
      userId: s.userId,
      email: s.account.email,
      sub: s.sub,
      scopes: reconsent.scopes,
    });
    expect(kept.id).toBe(s.account.id);
    expect(kept.status).toBe("active");
    expect(kept.scopes).toEqual(["email", "openid", GMAIL_RO, SHEETS].sort());
    const after = await accountRow(s.account.id);
    expect(after.refresh_ct).toBe(before.refresh_ct);
    expect(after.refresh_iv).toBe(before.refresh_iv);
    expect((await store.accounts.getRefreshToken(s.userId, s.account.id)) === s.refreshToken).toBe(true);
    // The kept token still works at the fake.
    await expect(getAccessToken(env, kept, fakeTransport)).resolves.toMatch(/^ya29\./);
  });

  it("replaces the stored refresh token when a new one is returned and reactivates the account", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-replace"), scopes: [GMAIL_RO] });
    await store.accounts.markStatus(s.userId, s.account.id, "reconnect");
    const fresh = await googleOAuth(env, fakeTransport).exchangeCode(
      await authorizeAtFake({ email: s.account.email, scopes: [GMAIL_RO] }),
    );
    expect(fresh.refreshToken).toBeDefined();
    const updated = await store.accounts.upsertConnected({
      userId: s.userId,
      email: s.account.email,
      sub: s.sub,
      scopes: fresh.scopes,
      refreshToken: fresh.refreshToken,
    });
    expect(updated.status).toBe("active");
    expect((await store.accounts.getRefreshToken(s.userId, s.account.id)) === fresh.refreshToken).toBe(true);
  });

  it("leaves a new account without any refresh token in reconnect status", async () => {
    const user = await store.users.create({ sub: rawSub(), email: uniqueEmail("db-notoken-u") });
    const acc = await store.accounts.upsertConnected({
      userId: user.id,
      email: uniqueEmail("db-notoken"),
      sub: rawSub(),
      scopes: ["openid"],
    });
    expect(acc.status).toBe("reconnect");
    expect(acc.hasRefreshToken).toBe(false);
  });

  it("fails with GWS_ACCOUNT_TAKEN when the Google account belongs to another user", async () => {
    const owner = await seedUserWithAccount(env, { email: uniqueEmail("db-taken"), scopes: [] });
    const other = await store.users.create({ sub: rawSub(), email: uniqueEmail("db-taken-other") });
    const attempt = { userId: other.id, email: owner.account.email, sub: owner.sub, scopes: [], refreshToken: "1//x" };
    expect(await codeOf(store.accounts.upsertConnected(attempt))).toBe("GWS_ACCOUNT_TAKEN");
    // Same email under a different Google identity is refused as well.
    expect(await codeOf(store.accounts.upsertConnected({ ...attempt, sub: rawSub() }))).toBe("GWS_ACCOUNT_TAKEN");
    expect((await store.accounts.get(owner.userId, owner.account.id))?.userId).toBe(owner.userId);
  });

  it("refuses malformed input", async () => {
    const user = await store.users.create({ sub: rawSub(), email: uniqueEmail("db-bad-u") });
    const ok = { userId: user.id, email: uniqueEmail("db-bad"), sub: rawSub(), scopes: [] as string[] };
    expect(await codeOf(store.accounts.upsertConnected({ ...ok, email: "no-at-sign" }))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(store.accounts.upsertConnected({ ...ok, sub: "" }))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(store.accounts.upsertConnected({ ...ok, scopes: ["has space"] }))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(store.accounts.upsertConnected({ ...ok, refreshToken: "" }))).toBe("GWS_INVALID_INPUT");
  });
});

describe("account settings", () => {
  it("allows exactly one default per user", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-def-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-def-b"), scopes: [], userId: a.userId });
    await store.accounts.setDefault(a.userId, b.account.id);
    const list = await store.accounts.listForUser(a.userId);
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([b.account.id]);
    expect((await store.accounts.resolve(a.userId)).id).toBe(b.account.id);
    await store.accounts.setDefault(a.userId, b.account.id);
    expect((await store.accounts.listForUser(a.userId)).filter((x) => x.isDefault)).toHaveLength(1);
  });

  it("cannot set another user's account as default", async () => {
    const mine = await seedUserWithAccount(env, { email: uniqueEmail("db-def-mine"), scopes: [] });
    const theirs = await seedUserWithAccount(env, { email: uniqueEmail("db-def-theirs"), scopes: [] });
    expect(await codeOf(store.accounts.setDefault(mine.userId, theirs.account.id))).toBe("GWS_ACCOUNT_UNKNOWN");
    expect((await store.accounts.resolve(mine.userId)).id).toBe(mine.account.id);
  });

  it("keeps aliases unique per user, rejects reserved shapes and clears with null", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-alias-a"), scopes: [], alias: "work" });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-alias-b"), scopes: [], userId: a.userId });
    expect(await codeOf(store.accounts.setAlias(a.userId, b.account.id, "Work"))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(store.accounts.setAlias(a.userId, b.account.id, "me@fake.test"))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(store.accounts.setAlias(a.userId, b.account.id, ""))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(store.accounts.setAlias(a.userId, b.account.id, "x".repeat(65)))).toBe("GWS_INVALID_INPUT");
    // Another user may use the same alias.
    const other = await seedUserWithAccount(env, { email: uniqueEmail("db-alias-o"), scopes: [] });
    expect((await store.accounts.setAlias(other.userId, other.account.id, "work")).alias).toBe("work");
    expect((await store.accounts.setAlias(a.userId, a.account.id, null)).alias).toBeUndefined();
    expect((await store.accounts.setAlias(a.userId, b.account.id, "work")).alias).toBe("work");
  });

  it("wipes the token and the scopes, marking the account disconnected", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-wipe"), scopes: [GMAIL_RO] });
    const wiped = await store.accounts.wipeToken(s.userId, s.account.id);
    expect(wiped.status).toBe("disconnected");
    expect(wiped.hasRefreshToken).toBe(false);
    expect(wiped.tokenGeneration).toBeNull();
    expect(wiped.scopes).toEqual([]);
    const row = await accountRow(s.account.id);
    expect(row.refresh_ct).toBeNull();
    expect(row.refresh_iv).toBeNull();
    expect(row.scopes).toBe("");
    expect(await codeOf(store.accounts.getRefreshToken(s.userId, s.account.id))).toBe("GWS_RECONNECT_REQUIRED");
  });

  it("keeps every client allowlist row of a wiped account, so an allowlisted client is told to reconnect", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-wipe-gr-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-wipe-gr-b"), scopes: [], userId: a.userId });
    const x = `client-${crypto.randomUUID()}`;
    const y = `client-${crypto.randomUUID()}`;
    await store.grants.replace(a.userId, x, [a.account.id, b.account.id]);
    await store.grants.add(a.userId, y, a.account.id);

    await store.accounts.wipeToken(a.userId, a.account.id);
    expect(await store.grants.list(a.userId, x)).toEqual([a.account.id, b.account.id].sort());
    expect(await store.grants.list(a.userId, y)).toEqual([a.account.id]);
  });

  it("never turns a disconnected account back into reconnect or active", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-disc"), scopes: [] });
    await store.accounts.wipeToken(s.userId, s.account.id);
    expect((await store.accounts.markStatus(s.userId, s.account.id, "reconnect")).status).toBe("disconnected");
    expect(await codeOf(store.accounts.markStatus(s.userId, s.account.id, "active"))).toBe("GWS_RECONNECT_REQUIRED");
    expect((await store.accounts.get(s.userId, s.account.id))?.status).toBe("disconnected");
    expect(await codeOf(store.accounts.markStatus(s.userId, "a_missing", "reconnect"))).toBe("GWS_ACCOUNT_UNKNOWN");
  });

  it("finds accounts by sub and lists them per user", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-find"), scopes: [GMAIL_RO] });
    expect((await store.accounts.findBySub(s.sub))?.id).toBe(s.account.id);
    expect(await store.accounts.findBySub("missing-sub")).toBeNull();
    expect((await store.accounts.listForUser(s.userId)).map((a) => a.id)).toEqual([s.account.id]);
    expect(await store.accounts.get("u_other", s.account.id)).toBeNull();
  });
});

/** Google's answer to a new consent of `email`: a fresh refresh token, as the connect flow's prompt=consent gets. */
async function consentWithToken(email: string, scopes: readonly string[] = ["openid"]) {
  const t = await googleOAuth(env, fakeTransport).exchangeCode(await authorizeAtFake({ email, scopes }));
  if (!t.refreshToken) throw new Error("fake issued no refresh token");
  return { scopes: t.scopes, refreshToken: t.refreshToken };
}

/** Every client allowlist row of one account, as "client" ids. */
async function rowsOf(userId: string, accountId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT client_id FROM client_grants WHERE user_id = ? AND account_id = ? ORDER BY client_id")
    .bind(userId, accountId)
    .all<{ client_id: string }>();
  return results.map((r) => r.client_id);
}

/**
 * A D1 binding over the test database that records how each statement is submitted ("first", "run", "all"
 * or one "batch") by its first three words, and can run `afterFirst` right after a matching read returns.
 * The cast is needed because only the methods the store uses are implemented.
 */
function recordingDb(afterFirst?: { match: string; run: () => Promise<void> }) {
  const log: string[][] = [];
  const real = new WeakMap<object, { sql: string; stmt: D1PreparedStatement }>();
  const head = (sql: string) => sql.trim().split(/\s+/).slice(0, 3).join(" ");
  let fired = false;
  const wrap = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...values: unknown[]) => wrap(sql, stmt.bind(...values)),
      async first<T>(): Promise<T | null> {
        log.push(["first", head(sql)]);
        const r = await stmt.first<T>();
        if (afterFirst && !fired && sql.includes(afterFirst.match)) {
          fired = true;
          await afterFirst.run();
        }
        return r;
      },
      run: () => (log.push(["run", head(sql)]), stmt.run()),
      all: () => (log.push(["all", head(sql)]), stmt.all()),
    };
    real.set(w, { sql, stmt });
    return w as unknown as D1PreparedStatement;
  };
  const unwrap = (x: D1PreparedStatement) => {
    const r = real.get(x);
    if (!r) throw new Error("batch got a statement this binding did not prepare");
    return r;
  };
  const db = {
    prepare: (sql: string) => wrap(sql, env.DB.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => {
      log.push(["batch", ...stmts.map((x) => head(unwrap(x).sql))]);
      return env.DB.batch(stmts.map((x) => unwrap(x).stmt));
    },
  };
  return { db: db as unknown as D1Database, log };
}

describe("reconnecting a disconnected account", () => {
  it("clears that account's allowlist rows when a consent with a token reactivates it, leaving other accounts' rows", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-rc-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-rc-b"), scopes: [], userId: a.userId });
    const x = `client-${crypto.randomUUID()}`;
    const y = `client-${crypto.randomUUID()}`;
    await store.grants.replace(a.userId, x, [a.account.id, b.account.id]);
    await store.grants.add(a.userId, y, a.account.id);
    await store.accounts.wipeToken(a.userId, a.account.id);

    const back = await store.accounts.upsertConnected({ userId: a.userId, email: a.account.email, sub: a.sub, ...(await consentWithToken(a.account.email)) });
    expect(back.status).toBe("active");
    expect(await rowsOf(a.userId, a.account.id)).toEqual([]);
    expect(await rowsOf(a.userId, b.account.id)).toEqual([x]);
  });

  it("clears the rows on a token-less consent too, so the later consent with a token restores no access", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-rc-p2"), scopes: [] });
    const x = `client-${crypto.randomUUID()}`;
    await store.grants.add(s.userId, x, s.account.id);
    await store.accounts.wipeToken(s.userId, s.account.id);

    // Google returns no refresh token when a grant already exists and prompt=consent was not sent.
    const tokenless = await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, scopes: ["openid"] });
    expect(tokenless.status).toBe("reconnect");
    expect(await rowsOf(s.userId, s.account.id)).toEqual([]);

    const back = await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, ...(await consentWithToken(s.account.email)) });
    expect(back.status).toBe("active");
    expect(await store.grants.isAllowed(s.userId, x, s.account.id)).toBe(false);
  });

  it("keeps the rows of an active or reconnect-state account across a re-consent", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-rc-keep"), scopes: [] });
    const x = `client-${crypto.randomUUID()}`;
    await store.grants.add(s.userId, x, s.account.id);
    await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, ...(await consentWithToken(s.account.email)) });
    expect(await rowsOf(s.userId, s.account.id)).toEqual([x]);
    await store.accounts.markStatus(s.userId, s.account.id, "reconnect");
    const back = await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, ...(await consentWithToken(s.account.email)) });
    expect(back.status).toBe("active");
    expect(await rowsOf(s.userId, s.account.id)).toEqual([x]);
  });

  it("clears a row added while the account was disconnected (a grant that raced the disconnect)", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-rc-race"), scopes: [] });
    await store.accounts.wipeToken(s.userId, s.account.id);
    const late = `client-${crypto.randomUUID()}`;
    await store.grants.add(s.userId, late, s.account.id);
    await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, ...(await consentWithToken(s.account.email)) });
    expect(await store.grants.isAllowed(s.userId, late, s.account.id)).toBe(false);
  });

  it("clears and reactivates in one batch, the clear first, with no separate write", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-rc-batch"), scopes: [] });
    await store.accounts.wipeToken(s.userId, s.account.id);
    const rec = recordingDb();
    const consent = await consentWithToken(s.account.email);
    await openStore({ DB: rec.db, TOKEN_ENC_KEY: env.TOKEN_ENC_KEY }).accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, ...consent });
    expect(rec.log.filter(([kind]) => kind !== "first")).toEqual([["batch", "DELETE FROM client_grants", "UPDATE accounts SET"]]);
  });

  it("decides the clear from the account's status at write time, not from the earlier read", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-rc-toctou"), scopes: [] });
    const x = `client-${crypto.randomUUID()}`;
    await store.grants.add(s.userId, x, s.account.id);
    const consent = await consentWithToken(s.account.email);
    // A disconnect lands after the consent read the account as active and before it writes.
    const rec = recordingDb({ match: "google_sub = ?", run: async () => void (await store.accounts.wipeToken(s.userId, s.account.id)) });
    const back = await openStore({ DB: rec.db, TOKEN_ENC_KEY: env.TOKEN_ENC_KEY }).accounts.upsertConnected({
      userId: s.userId,
      email: s.account.email,
      sub: s.sub,
      ...consent,
    });
    expect(back.status).toBe("active");
    expect(await rowsOf(s.userId, s.account.id)).toEqual([]);
  });
});

describe("refresh token for revoke", () => {
  it("decrypts the stored token of an account in reconnect state, which the regular read refuses", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-revoke-rc"), scopes: [] });
    await store.accounts.markStatus(s.userId, s.account.id, "reconnect");
    expect(await codeOf(store.accounts.getRefreshToken(s.userId, s.account.id))).toBe("GWS_RECONNECT_REQUIRED");
    expect((await store.accounts.getRefreshTokenForRevoke(s.userId, s.account.id)) === s.refreshToken).toBe(true);
  });

  it("returns the token of an active account and null once the token is wiped", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-revoke-act"), scopes: [] });
    expect((await store.accounts.getRefreshTokenForRevoke(s.userId, s.account.id)) === s.refreshToken).toBe(true);
    await store.accounts.wipeToken(s.userId, s.account.id);
    expect(await store.accounts.getRefreshTokenForRevoke(s.userId, s.account.id)).toBeNull();
  });

  it("refuses another user's account, a moved ciphertext and an unsupported key version", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-revoke-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-revoke-b"), scopes: [] });
    expect(await codeOf(store.accounts.getRefreshTokenForRevoke(a.userId, b.account.id))).toBe("GWS_ACCOUNT_UNKNOWN");
    const rowA = await accountRow(a.account.id);
    const c = await seedUserWithAccount(env, { email: uniqueEmail("db-revoke-c"), scopes: [], userId: a.userId });
    await env.DB.prepare("UPDATE accounts SET refresh_ct = ?, refresh_iv = ? WHERE id = ?").bind(rowA.refresh_ct, rowA.refresh_iv, c.account.id).run();
    expect(await codeOf(store.accounts.getRefreshTokenForRevoke(a.userId, c.account.id))).toBe("GWS_INTERNAL");
    await env.DB.prepare("UPDATE accounts SET key_version = 2 WHERE id = ?").bind(b.account.id).run();
    expect(await codeOf(store.accounts.getRefreshTokenForRevoke(b.userId, b.account.id))).toBe("GWS_INTERNAL");
  });
});

describe("refresh token ciphertext binding", () => {
  it("refuses a ciphertext moved to another account row", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-swap-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-swap-b"), scopes: [], userId: a.userId });
    const rowA = await accountRow(a.account.id);
    await env.DB.prepare("UPDATE accounts SET refresh_ct = ?, refresh_iv = ? WHERE id = ?")
      .bind(rowA.refresh_ct, rowA.refresh_iv, b.account.id)
      .run();
    expect(await codeOf(store.accounts.getRefreshToken(a.userId, b.account.id))).toBe("GWS_INTERNAL");
    expect((await store.accounts.getRefreshToken(a.userId, a.account.id)) === a.refreshToken).toBe(true);
  });

  it("refuses a row whose key version does not match", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-kv"), scopes: [] });
    await env.DB.prepare("UPDATE accounts SET key_version = 2 WHERE id = ?").bind(s.account.id).run();
    expect(await codeOf(store.accounts.getRefreshToken(s.userId, s.account.id))).toBe("GWS_INTERNAL");
  });
});

describe("grants", () => {
  it("replaces a client's allowlist exactly and answers isAllowed", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-gr-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-gr-b"), scopes: [], userId: a.userId });
    const c = await seedUserWithAccount(env, { email: uniqueEmail("db-gr-c"), scopes: [], userId: a.userId });
    const client = `client-${crypto.randomUUID()}`;

    await store.grants.replace(a.userId, client, [a.account.id, b.account.id]);
    expect(await store.grants.list(a.userId, client)).toEqual([a.account.id, b.account.id].sort());
    await store.grants.replace(a.userId, client, [c.account.id, c.account.id]);
    expect(await store.grants.list(a.userId, client)).toEqual([c.account.id]);
    expect(await store.grants.isAllowed(a.userId, client, c.account.id)).toBe(true);
    expect(await store.grants.isAllowed(a.userId, client, a.account.id)).toBe(false);
    expect(await store.grants.isAllowed(a.userId, "other-client", c.account.id)).toBe(false);
    await store.grants.replace(a.userId, client, []);
    expect(await store.grants.list(a.userId, client)).toEqual([]);
  });

  it("adds, removes and drops a whole client", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("db-gr2-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("db-gr2-b"), scopes: [], userId: a.userId });
    const client = `client-${crypto.randomUUID()}`;
    await store.grants.add(a.userId, client, a.account.id);
    await store.grants.add(a.userId, client, a.account.id);
    await store.grants.add(a.userId, client, b.account.id);
    expect(await store.grants.list(a.userId, client)).toEqual([a.account.id, b.account.id].sort());
    await store.grants.remove(a.userId, client, a.account.id);
    expect(await store.grants.list(a.userId, client)).toEqual([b.account.id]);
    await store.grants.removeClient(a.userId, client);
    expect(await store.grants.list(a.userId, client)).toEqual([]);
  });

  it("refuses another user's account and leaves the previous allowlist intact", async () => {
    const mine = await seedUserWithAccount(env, { email: uniqueEmail("db-gr3-m"), scopes: [] });
    const theirs = await seedUserWithAccount(env, { email: uniqueEmail("db-gr3-t"), scopes: [] });
    const client = `client-${crypto.randomUUID()}`;
    await store.grants.replace(mine.userId, client, [mine.account.id]);
    expect(await codeOf(store.grants.replace(mine.userId, client, [theirs.account.id]))).toBe("GWS_ACCOUNT_UNKNOWN");
    expect(await codeOf(store.grants.add(mine.userId, client, theirs.account.id))).toBe("GWS_ACCOUNT_UNKNOWN");
    expect(await store.grants.list(mine.userId, client)).toEqual([mine.account.id]);
  });
});

describe("audit and rate counters", () => {
  it("inserts audit rows in one batch", async () => {
    const executeId = `ex-${crypto.randomUUID()}`;
    const row = (n: number): AuditRow => ({
      id: `${executeId}-${n}`,
      ts: Date.now(),
      execute_id: executeId,
      user_id: "u_audit",
      client_id: "client-audit",
      account_id: null,
      fn: "gmail.users.messages.list",
      effect: "read",
      applied: 0,
      status: "ok",
      code: null,
      duration_ms: 3,
      request_id: null,
      upstream_status: 200,
    });
    await store.audit.insertMany([row(1), row(2), row(3)]);
    await store.audit.insertMany([]);
    const { results } = await env.DB.prepare("SELECT id FROM audit_log WHERE execute_id = ? ORDER BY id")
      .bind(executeId)
      .all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual([1, 2, 3].map((n) => `${executeId}-${n}`));
  });

  it("increments a fixed-window counter per key and window", async () => {
    const key = `user:${crypto.randomUUID()}`;
    expect(await store.rate.hit(key, 1000)).toBe(1);
    expect(await store.rate.hit(key, 1000)).toBe(2);
    expect(await store.rate.hit(key, 1000)).toBe(3);
    expect(await store.rate.hit(key, 2000)).toBe(1);
    expect(await store.rate.hit(`${key}-other`, 1000)).toBe(1);
  });

  it("reads a window's count without writing it", async () => {
    const key = `user:${crypto.randomUUID()}`;
    expect(await store.rate.count(key, 1000)).toBe(0);
    expect(await store.rate.count(key, 1000)).toBe(0);
    await store.rate.hit(key, 1000);
    await store.rate.hit(key, 1000);
    expect(await store.rate.count(key, 1000)).toBe(2);
    expect(await store.rate.count(key, 2000)).toBe(0);
  });

  it("prunes counter rows of windows before a bound, at most a batch at a time", async () => {
    const key = `prune:${crypto.randomUUID()}`;
    for (const w of [100, 200, 300, 400]) await store.rate.hit(key, w);
    const remaining = async () =>
      (await env.DB.prepare("SELECT window_start FROM rate_counters WHERE key = ? ORDER BY window_start").bind(key).all<{ window_start: number }>()).results.map(
        (r) => r.window_start,
      );
    expect(await store.rate.prune(400, 2)).toBe(2);
    expect((await remaining()).filter((w) => w < 400)).toHaveLength(1);
    expect(await store.rate.prune(400, 100)).toBeGreaterThanOrEqual(1);
    expect(await remaining()).toEqual([400]);
  });
});

describe("client approvals", () => {
  it("knows a grant only under the user and client it was recorded for", async () => {
    const user = await store.users.create({ sub: rawSub(), email: uniqueEmail("db-approval") });
    const other = await store.users.create({ sub: rawSub(), email: uniqueEmail("db-approval-other") });
    await store.approvals.record({ userId: user.id, clientId: "client-a", grantId: "grant_1", clientName: "A" });
    expect(await store.approvals.has(user.id, "client-a", "grant_1")).toBe(true);
    // Same user and grant, another client: not approved.
    expect(await store.approvals.has(user.id, "client-b", "grant_1")).toBe(false);
    expect(await store.approvals.has(other.id, "client-a", "grant_1")).toBe(false);
    expect(await store.approvals.has(user.id, "client-a", "grant_2")).toBe(false);
  });
});

describe("no plaintext tokens at rest", () => {
  // Columns holding AES-GCM ciphertext as base64. The raw base64 text is random and its alphabet includes
  // "1" and "/", so the token-prefix heuristic can match it by chance; only the prefix heuristic is skipped
  // there. Exact token values and every decoded view are still checked.
  const CIPHERTEXT_COLUMNS = ["accounts.refresh_ct"];
  const TOKEN_PREFIXES = ["ya29.", "1//"];

  /** True when `view` shows a token prefix; `raw` marks the undecoded base64 text of a ciphertext column. */
  function hasTokenPrefix(view: string, raw: boolean, ciphertext: boolean): boolean {
    if (raw && ciphertext) return false;
    return TOKEN_PREFIXES.some((p) => view.includes(p));
  }

  /** The previous predicate: prefix check on every view, raw ciphertext included. */
  function previousHasTokenPrefix(view: string): boolean {
    return TOKEN_PREFIXES.some((p) => view.includes(p));
  }

  it("skips the prefix heuristic only on raw ciphertext, never on tokens or decoded views", () => {
    // Bytes 0xd7 0xff 0xff encode to "1//" in base64 and are not a token.
    const randomLooking = btoa(String.fromCharCode(0xd7, 0xff, 0xff, 0x01, 0x02, 0x03));
    expect(randomLooking.includes("1//")).toBe(true);
    expect(previousHasTokenPrefix(randomLooking)).toBe(true);
    expect(hasTokenPrefix(randomLooking, true, true)).toBe(false);
    // Same string in a non-ciphertext column, or as a decoded view, is still flagged.
    expect(hasTokenPrefix(randomLooking, true, false)).toBe(true);
    expect(hasTokenPrefix("1//real-refresh-token", false, true)).toBe(true);
    expect(hasTokenPrefix("ya29.access", true, true)).toBe(false);
    expect(hasTokenPrefix("ya29.access", false, true)).toBe(true);
  });

  it("finds no access or refresh token in any D1 table after a connect and refresh cycle", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("db-scan"), scopes: [GMAIL_RO] });
    const access = await getAccessToken(env, s.account, fakeTransport);
    await store.accounts.upsertConnected({ userId: s.userId, email: s.account.email, sub: s.sub, scopes: [DRIVE_FILE] });

    const row = await accountRow(s.account.id);
    expect(typeof row.refresh_ct).toBe("string");
    const scanned = new Set<string>();
    for (const table of ["users", "accounts", "client_grants", "audit_log", "rate_counters"]) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      for (const r of results) {
        for (const [col, value] of Object.entries(r)) {
          const where = `${table}.${col}`;
          scanned.add(where);
          const ciphertext = CIPHERTEXT_COLUMNS.includes(where);
          stringViews(value).forEach((v, i) => {
            expect(hasTokenPrefix(v, i === 0, ciphertext), where).toBe(false);
            expect(v.includes(s.refreshToken), where).toBe(false);
            expect(v.includes(access), where).toBe(false);
          });
        }
      }
    }
    // A renamed ciphertext column must fail here rather than silently lose its exemption.
    for (const column of CIPHERTEXT_COLUMNS) expect(scanned.has(column), column).toBe(true);
  });
});

describe("store env type", () => {
  it("does not accept the secret-stripped host env", () => {
    const host = omitSecrets(env);
    // Never invoked: the assertion is the compile error below.
    const open = () =>
      // @ts-expect-error the store needs TOKEN_ENC_KEY, which the host env deliberately lacks
      openStore(host);
    expect(typeof open).toBe("function");
  });
});

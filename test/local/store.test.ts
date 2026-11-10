import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRow } from "../../src/contracts";
import { takeConnectRequest } from "../../src/core/accounts-capability";
import type { LinkStore } from "../../src/core/ports";
import { isGwsError } from "../../src/errors";
import { createGoogleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { DB_FILE, LOCAL_USER_ID, openLocalStore, SCHEMA_VERSION, type LocalStore } from "../../src/local/store";
import type { LocalSecrets } from "../../src/local/secrets";
import { connectAtFake, localConfig, openLocal, stubFakeGoogle, tempDir, type FakeGoogle } from "./helpers";

const posixOnly = process.platform === "win32" ? it.skip : it;
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const config = localConfig();

/** Every temp dir a test made, removed after it (a test may make several). */
const cleanups: Array<() => void> = [];
let opened: LocalStore[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  opened = [];
  vi.unstubAllGlobals();
  for (const c of cleanups.splice(0).reverse()) c();
});

async function setup(): Promise<{ dir: string; store: LocalStore; secrets: LocalSecrets }> {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const local = await openLocal(t.dir);
  opened.push(local.store);
  return { dir: t.dir, store: local.store, secrets: local.secrets };
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isGwsError(e) ? `${e.code}: ${e.message}` : String(e);
  }
  return "resolved";
}

/** The fake's transport, in process (what `localPorts` builds from the same config in fake mode). */
function fakeOAuth(fake: FakeGoogle, secrets: LocalSecrets) {
  const send = createTransport({ FAKE_GOOGLE: { fetch: (u, init) => fake.handler(new Request(u, init)) } }, config);
  return createGoogleOAuth(config, secrets.source, send);
}

describe("the local database file", () => {
  posixOnly("lives in a mode 700 directory as a mode 600 file, sidecars included", async () => {
    const { dir, store } = await setup();
    expect(store.path).toBe(path.join(dir, DB_FILE));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(store.checks.map((c) => [path.basename(c.path), c.action])).toEqual([
      ["config", "ok"],
      [DB_FILE, "created"],
    ]);
    await store.rate.hit("probe", 0);
    const files = readdirSync(dir).filter((f) => f.startsWith(DB_FILE));
    expect(files.sort()).toEqual([DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`]);
    for (const f of files) expect([f, statSync(path.join(dir, f)).mode & 0o777]).toEqual([f, 0o600]);
  });

  posixOnly("repairs looser modes on open and says which, and refuses a symlinked database", async () => {
    const { dir, store, secrets } = await setup();
    store.close();
    opened = [];
    chmodSync(dir, 0o755);
    chmodSync(store.path, 0o644);
    const again = openLocalStore({ dir, upstream: "fake", secrets: secrets.source, redactor: secrets.redactor });
    opened.push(again);
    expect(again.checks.filter((c) => c.action === "repaired").map((c) => [path.basename(c.path), c.previousMode])).toEqual([
      ["config", 0o755],
      [DB_FILE, 0o644],
    ]);
    again.close();
    opened = [];

    const other = tempDir();
    try {
      const target = path.join(dir, DB_FILE);
      const linkDir = path.join(path.dirname(other.dir), "linked");
      mkdirSync(linkDir, { mode: 0o700 });
      symlinkSync(target, path.join(linkDir, DB_FILE));
      const message = await rejection(Promise.resolve().then(() => openLocalStore({ dir: linkDir, upstream: "fake", secrets: secrets.source, redactor: secrets.redactor })));
      expect(message).toBe(`GWS_INTERNAL: refusing to use ${path.join(linkDir, DB_FILE)}: it is a symbolic link`);
    } finally {
      other.cleanup();
    }
  });

  it("applies versioned migrations once, and refuses a database from a newer version", async () => {
    const { dir, store, secrets } = await setup();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    store.close();
    opened = [];
    const raw = new DatabaseSync(path.join(dir, DB_FILE));
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(["accounts", "audit_log", "client_approvals", "client_grants", "links", "meta", "rate_counters", "users"]);
    expect(raw.prepare("SELECT id FROM users").all()).toEqual([{ id: LOCAL_USER_ID }]);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    const message = await rejection(Promise.resolve().then(() => openLocalStore({ dir, upstream: "fake", secrets: secrets.source, redactor: secrets.redactor })));
    expect(message).toBe("GWS_INTERNAL: the database was created by a newer gws-mcp; upgrade gws-mcp to use it");

    const fresh = new DatabaseSync(path.join(dir, DB_FILE));
    fresh.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    fresh.close();
    const reopened = openLocalStore({ dir, upstream: "fake", secrets: secrets.source, redactor: secrets.redactor });
    opened.push(reopened);
    expect(reopened.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("the database's upstream", () => {
  it("records the upstream it was created for and refuses to open with the other one", async () => {
    const { dir, store, secrets } = await setup();
    expect(store.upstream).toBe("fake");
    store.close();
    opened = [];
    const message = await rejection(
      Promise.resolve().then(() => openLocalStore({ dir, upstream: "google", secrets: secrets.source, redactor: secrets.redactor })),
    );
    expect(message).toBe(
      "GWS_INTERNAL: this database holds accounts connected through the fake upstream; refusing to use it with the google upstream (use another config directory)",
    );
    const again = openLocalStore({ dir, upstream: "fake", secrets: secrets.source, redactor: secrets.redactor });
    opened.push(again);
    expect(again.upstream).toBe("fake");
  });
});

describe("two processes on one database", () => {
  it("waits for another process's write lock instead of failing at once (busy timeout)", async () => {
    const { store } = await setup();
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      db.exec("COMMIT");
      db.close();`;
    const child = spawn(process.execPath, ["--no-warnings", "-e", script, store.path], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    const t0 = Date.now();
    expect(await store.rate.hit("busy", 0)).toBe(1);
    expect(Date.now() - t0).toBeGreaterThan(100);
    await new Promise((resolve) => child.once("exit", resolve));
  });
});

describe("accounts and refresh tokens", () => {
  let fake: FakeGoogle;
  beforeEach(() => {
    fake = stubFakeGoogle();
  });

  it("runs the remote account rules over SQLite: first account is the default, aliases, default switch, wipe", async () => {
    const { store } = await setup();
    const a = await connectAtFake(fake, config, store, "one@fake.test", [DRIVE_FILE]);
    const b = await connectAtFake(fake, config, store, "two@fake.test", [DRIVE_FILE]);
    expect([a.account.isDefault, b.account.isDefault]).toEqual([true, false]);
    await store.accounts.setAlias(LOCAL_USER_ID, b.account.id, "Work");
    expect((await store.accounts.resolve(LOCAL_USER_ID, "work")).id).toBe(b.account.id);
    expect(await rejection(store.accounts.setAlias(LOCAL_USER_ID, a.account.id, "work"))).toBe(
      "GWS_INVALID_INPUT: alias is already used by another of your accounts",
    );
    await store.accounts.setDefault(LOCAL_USER_ID, b.account.id);
    const list = await store.accounts.listForUser(LOCAL_USER_ID);
    expect(list.map((x) => [x.email, x.isDefault])).toEqual([
      ["one@fake.test", false],
      ["two@fake.test", true],
    ]);
    const wiped = await store.accounts.wipeToken(LOCAL_USER_ID, a.account.id);
    expect([wiped.status, wiped.hasRefreshToken]).toEqual(["disconnected", false]);
    expect(await rejection(store.accounts.resolve(LOCAL_USER_ID, "one@fake.test"))).toMatch(/^GWS_RECONNECT_REQUIRED/);
  });

  it("stores refresh tokens only as AES-GCM ciphertext bound to the account (AAD)", async () => {
    const { dir, store } = await setup();
    const a = await connectAtFake(fake, config, store, "seal-a@fake.test", [DRIVE_FILE]);
    const b = await connectAtFake(fake, config, store, "seal-b@fake.test", [DRIVE_FILE]);
    expect(await store.accounts.getRefreshToken(LOCAL_USER_ID, a.account.id)).toBe(a.refreshToken);
    for (const f of readdirSync(dir).filter((x) => x.startsWith(DB_FILE))) {
      const bytes = readFileSync(path.join(dir, f)).toString("latin1");
      expect([f, bytes.includes(a.refreshToken), bytes.includes(b.refreshToken)]).toEqual([f, false, false]);
    }
    // A ciphertext moved to another account's row does not decrypt: the AAD names the account.
    const raw = new DatabaseSync(path.join(dir, DB_FILE));
    raw.prepare("UPDATE accounts SET refresh_ct = (SELECT refresh_ct FROM accounts WHERE id = ?), refresh_iv = (SELECT refresh_iv FROM accounts WHERE id = ?) WHERE id = ?").run(
      a.account.id,
      a.account.id,
      b.account.id,
    );
    raw.close();
    expect(await rejection(store.accounts.getRefreshToken(LOCAL_USER_ID, b.account.id))).toBe("GWS_INTERNAL: stored token failed to decrypt");
  });

  it("caches access tokens encrypted in memory only, bound to the token generation", async () => {
    const { dir, store, secrets } = await setup();
    const a = await connectAtFake(fake, config, store, "cache@fake.test", [DRIVE_FILE]);
    const cache = store.tokenCache(fakeOAuth(fake, secrets));
    const before = fake.seen.length;
    const tokenCalls = () => fake.seen.slice(before).length;
    const account = await store.accounts.resolve(LOCAL_USER_ID, "cache@fake.test");
    const first = await cache.getAccessToken(account);
    const refreshes = tokenCalls();
    expect(await cache.getAccessToken(account)).toBe(first);
    expect(tokenCalls()).toBe(refreshes);
    for (const f of readdirSync(dir).filter((x) => x.startsWith(DB_FILE))) {
      expect(readFileSync(path.join(dir, f)).toString("latin1").includes(first)).toBe(false);
    }
    // Every token loaded or minted is redacted from local output from now on.
    expect(secrets.redactor.redact(`${a.refreshToken} ${first}`)).toBe("[REDACTED] [REDACTED]");
    // A new refresh token (new generation) never gets the old access token.
    await connectAtFake(fake, config, store, "cache@fake.test", [DRIVE_FILE], a.sub);
    const fresh = await store.accounts.resolve(LOCAL_USER_ID, "cache@fake.test");
    expect(fresh.tokenGeneration).not.toBe(account.tokenGeneration);
    expect(await cache.getAccessToken(fresh)).not.toBe(first);
  });

  it("remembers every token it loads or mints for redaction, whatever its shape", async () => {
    const { store, secrets } = await setup();
    const account = await store.accounts.upsertConnected({
      userId: LOCAL_USER_ID,
      email: "opaque@example.test",
      sub: "opaque-sub",
      scopes: [DRIVE_FILE],
      refreshToken: "opaque-refresh-token-0003",
    });
    const cache = store.tokenCache({ refresh: async () => ({ accessToken: "opaque-access-token-0003", expiresIn: 3600, scopes: [DRIVE_FILE] }) });
    const text = "opaque-refresh-token-0003 opaque-access-token-0003";
    expect(secrets.redactor.redact(text)).toBe(text);
    expect(await cache.getAccessToken(account)).toBe("opaque-access-token-0003");
    expect(secrets.redactor.redact(text)).toBe("[REDACTED] [REDACTED]");
  });

  it("refuses an account that is not active even on a cache hit, and marks a revoked grant for reconnect", async () => {
    const { store, secrets } = await setup();
    const a = await connectAtFake(fake, config, store, "revoked@fake.test", [DRIVE_FILE]);
    const oauth = fakeOAuth(fake, secrets);
    const cache = store.tokenCache(oauth);
    const account = await store.accounts.resolve(LOCAL_USER_ID, "revoked@fake.test");
    await cache.getAccessToken(account);
    expect(await rejection(cache.getAccessToken({ ...account, status: "reconnect" }))).toMatch(/^GWS_RECONNECT_REQUIRED/);
    await oauth.revoke(a.refreshToken);
    await cache.invalidate(account.id);
    expect(await rejection(cache.getAccessToken(account))).toMatch(/^GWS_RECONNECT_REQUIRED/);
    expect((await store.accounts.get(LOCAL_USER_ID, account.id))?.status).toBe("reconnect");
  });

  it("refuses to decrypt without the key, naming the secret only", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const local = await openLocal(t.dir);
    opened.push(local.store);
    const a = await connectAtFake(fake, config, local.store, "nokey@fake.test", [DRIVE_FILE]);
    const keyless = openLocalStore({ dir: t.dir, upstream: "fake", secrets: { get: () => undefined }, redactor: local.secrets.redactor });
    opened.push(keyless);
    expect(await rejection(keyless.accounts.getRefreshToken(LOCAL_USER_ID, a.account.id))).toBe("GWS_INTERNAL: missing secret TOKEN_ENC_KEY");
  });
});

describe("single-use link records", () => {
  const record = (exp: number) => JSON.stringify({ kind: "connect", userId: LOCAL_USER_ID, clientId: "local", services: ["drive"], exp });

  it("stores a record until its lifetime ends", async () => {
    let now = 1_000_000;
    const t = tempDir();
    cleanups.push(t.cleanup);
    const local = await openLocal(t.dir);
    local.store.close();
    const store = openLocalStore({ dir: t.dir, upstream: "fake", secrets: local.secrets.source, redactor: local.secrets.redactor, now: () => now });
    opened.push(store);
    await store.links.put("k1", "v1", { expirationTtl: 60 });
    expect(await store.links.get("k1")).toBe("v1");
    now += 60_000;
    expect(await store.links.get("k1")).toBeNull();
    expect(await rejection(store.links.put("k2", "v", { expirationTtl: Number.NaN }))).toBe("GWS_INTERNAL: invalid link record lifetime");
  });

  async function linkFor(store: LocalStore, token: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const key = `req:connect:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    await store.links.put(key, record(Date.now() + 60_000), { expirationTtl: 600 });
    return key;
  }

  it("is taken at most once by concurrent takers", async () => {
    const { store } = await setup();
    const token = "A".repeat(43);
    const key = await linkFor(store, token);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => takeConnectRequest(store.links, token, LOCAL_USER_ID)));
    expect(results.filter((r) => r.status === "fulfilled" && r.value !== null)).toHaveLength(1);
    expect(await store.links.get(key)).toBeNull();
    expect(await takeConnectRequest(store.links, token, LOCAL_USER_ID)).toBeNull();
  });

  it("is taken at most once even when every taker reads it before any deletes (one DELETE … RETURNING)", async () => {
    const { store } = await setup();
    const token = "B".repeat(43);
    await linkFor(store, token);
    const takers = 5;
    let reads = 0;
    let release: () => void = () => undefined;
    const allRead = new Promise<void>((r) => (release = r));
    // Holds each read until all takers have read the record: the worst interleaving of get and delete.
    const racing: LinkStore = {
      get: async (k) => {
        const v = await store.links.get(k);
        if (++reads === takers) release();
        await allRead;
        return v;
      },
      put: store.links.put,
      delete: store.links.delete,
    };
    const results = await Promise.all(Array.from({ length: takers }, () => takeConnectRequest(racing, token, LOCAL_USER_ID)));
    expect(reads).toBe(takers);
    // The losers' deletes are refused, and the core reads that as "no record".
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(takers - 1);
    // The adapter itself: a second delete of one record is refused.
    const k = await linkFor(store, "D".repeat(43));
    await store.links.delete(k);
    await expect(store.links.delete(k)).rejects.toMatchObject({
      code: "GWS_INVALID_INPUT",
      message: "this link was already used or has expired",
    });
  });

  it("a peek does not consume it", async () => {
    const { store } = await setup();
    const key = await linkFor(store, "C".repeat(43));
    expect(await store.links.get(key)).not.toBeNull();
    expect(await store.links.get(key)).not.toBeNull();
  });
});

describe("audit and rate counters", () => {
  it("writes audit rows atomically and metadata only", async () => {
    const { dir, store } = await setup();
    const row: AuditRow = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      execute_id: "x1",
      user_id: LOCAL_USER_ID,
      client_id: "local",
      account_id: null,
      fn: "drive.files.list",
      effect: "read",
      applied: 0,
      status: "ok",
      code: null,
      duration_ms: 3,
      request_id: null,
      upstream_status: 200,
    };
    await store.audit.insertMany([row]);
    // One bad row fails the whole batch: the good one before it is not written either.
    expect(await rejection(store.audit.insertMany([{ ...row, id: crypto.randomUUID() }, { ...row, id: crypto.randomUUID(), effect: "delete" as "read" }]))).toMatch(
      /CHECK constraint failed/,
    );
    const raw = new DatabaseSync(path.join(dir, DB_FILE));
    const columns = (raw.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(Object.keys(row));
    expect(raw.prepare("SELECT count(*) AS n FROM audit_log").get()).toEqual({ n: 1 });
    raw.close();
  });

  it("counts hits per fixed window", async () => {
    const { store } = await setup();
    expect([await store.rate.hit("u:local", 60), await store.rate.hit("u:local", 60), await store.rate.hit("u:local", 120)]).toEqual([1, 2, 1]);
    expect(await rejection(store.rate.hit("", 60))).toMatch(/^GWS_INVALID_INPUT/);
  });
});

describe("the D1-compatible layer", () => {
  it("rolls a failed batch back as a whole (setDefault keeps exactly one default)", async () => {
    const { store } = await setup();
    const fake = stubFakeGoogle();
    const a = await connectAtFake(fake, config, store, "batch-a@fake.test", [DRIVE_FILE]);
    await connectAtFake(fake, config, store, "batch-b@fake.test", [DRIVE_FILE]);
    expect(await rejection(store.accounts.setDefault(LOCAL_USER_ID, "a_missing"))).toBe("GWS_ACCOUNT_UNKNOWN: no such connected account");
    const defaults = (await store.accounts.listForUser(LOCAL_USER_ID)).filter((x) => x.isDefault).map((x) => x.id);
    expect(defaults).toEqual([a.account.id]);
  });
});

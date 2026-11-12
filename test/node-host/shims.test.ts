import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { isGwsError } from "../../src/errors";
import { NodeD1Database } from "../../src/runtime/node/d1";
import { BUSY_TIMEOUT_MS, openDatabase, sweepKv } from "../../src/runtime/node/database";
import { KV_TABLE_SQL, NodeKvNamespace, sweepExpiredKv } from "../../src/runtime/node/kv";
import { D1_MIGRATIONS, applyMigrations } from "../../src/runtime/node/migrations";
import { openAccessStore } from "../../src/store/access";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "migrations");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gws-node-host-db-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "gws-mcp.db");
}

function d1(): { raw: DatabaseSync; db: NodeD1Database } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)");
  return { raw, db: new NodeD1Database(raw) };
}

describe("D1 migrations on the Node host", () => {
  it("embeds exactly the D1 migration files, in order, with the same text", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(D1_MIGRATIONS.map((m) => m.name)).toEqual(files);
    for (const m of D1_MIGRATIONS) expect(m.sql, m.name).toBe(readFileSync(path.join(MIGRATIONS_DIR, m.name), "utf8"));
  });

  it("applies each migration once and records it as wrangler does", () => {
    const raw = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    expect(applyMigrations(raw)).toEqual(D1_MIGRATIONS.map((m) => m.name));
    expect(applyMigrations(raw)).toEqual([]);
    const rows = raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => r.name);
    expect(rows).toEqual(D1_MIGRATIONS.map((m) => m.name));
  });

  it("applies only the migrations a database lacks", () => {
    const raw = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    expect(applyMigrations(raw, D1_MIGRATIONS.slice(0, 2))).toEqual(["0001_init.sql", "0002_client_approvals.sql"]);
    expect(applyMigrations(raw)).toEqual(D1_MIGRATIONS.slice(2).map((m) => m.name));
  });

  it("rolls back a failing migration and records nothing for it", () => {
    const raw = new DatabaseSync(":memory:");
    const broken = [{ name: "0001_x.sql", sql: "CREATE TABLE a (x INTEGER); CREATE TABLE a (y INTEGER);" }];
    expect(() => applyMigrations(raw, broken)).toThrow(/migration 0001_x\.sql failed/);
    expect(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'a'").get()?.n).toBe(0);
    expect(raw.prepare("SELECT count(*) AS n FROM d1_migrations").get()?.n).toBe(0);
  });

  it("refuses a database migrated by a newer build", () => {
    const raw = new DatabaseSync(":memory:");
    applyMigrations(raw);
    raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("9999_future.sql");
    expect(() => applyMigrations(raw)).toThrow(/9999_future\.sql.*newer gws-mcp/);
  });
});

describe("the Node host database file", () => {
  it("is owner-only, in WAL mode with a busy timeout and foreign keys, migrated, with the KV table", () => {
    const file = tempDb();
    const { db, applied } = openDatabase(file);
    try {
      expect(applied).toEqual(D1_MIGRATIONS.map((m) => m.name));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(BUSY_TIMEOUT_MS);
      expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'node_kv'").get()?.n).toBe(1);
    } finally {
      db.close();
    }
    const again = openDatabase(file);
    expect(again.applied).toEqual([]);
    again.db.close();
  });

  it("a batch is one write transaction: it waits for another connection's lock, and fails whole when it cannot get it", async () => {
    const file = tempDb();
    const { db: raw } = openDatabase(file);
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)");
    raw.exec("PRAGMA busy_timeout = 50");
    const db = new NodeD1Database(raw);
    const other = new DatabaseSync(file);
    try {
      other.exec("BEGIN IMMEDIATE");
      await expect(db.batch([db.prepare("INSERT INTO t (name) VALUES ('a')"), db.prepare("INSERT INTO t (name) VALUES ('b')")])).rejects.toThrow(/locked|busy/i);
      other.exec("COMMIT");
      expect((await db.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(0);
      const [a, b] = await db.batch([db.prepare("INSERT INTO t (name) VALUES ('a')"), db.prepare("INSERT INTO t (name) VALUES ('b')")]);
      expect([a?.meta.changes, b?.meta.changes]).toEqual([1, 1]);
      // The other connection sees the committed batch.
      expect(other.prepare("SELECT count(*) AS n FROM t").get()?.n).toBe(2);
    } finally {
      other.close();
      raw.close();
    }
  });
});

describe("D1 shim", () => {
  it("first/all/run/raw return D1 shapes", async () => {
    const { db } = d1();
    const ins = await db.prepare("INSERT INTO t (name) VALUES (?), (?)").bind("a", "b").run();
    expect(ins.success).toBe(true);
    expect(ins.meta.changes).toBe(2);
    expect(ins.meta.last_row_id).toBe(2);
    expect(await db.prepare("SELECT name FROM t WHERE id = ?").bind(1).first()).toEqual({ name: "a" });
    expect(await db.prepare("SELECT name FROM t WHERE id = ?").bind(2).first("name")).toBe("b");
    expect(await db.prepare("SELECT name FROM t WHERE id = ?").bind(9).first()).toBeNull();
    const all = await db.prepare("SELECT id, name FROM t ORDER BY id").all();
    expect(all.results).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    expect(Object.getPrototypeOf(all.results[0])).toBe(Object.prototype);
    expect(all.meta.changes, "a SELECT reports no changes, not the previous write's").toBe(0);
    expect(await db.prepare("SELECT id, name FROM t ORDER BY id").raw()).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(await db.prepare("SELECT id FROM t WHERE id = 1").raw({ columnNames: true })).toEqual([["id"], [1]]);
    // raw() leaves the cached statement returning objects again.
    expect(await db.prepare("SELECT id FROM t WHERE id = 1").first()).toEqual({ id: 1 });
  });

  it("binds booleans as 0/1 and refuses undefined and objects", async () => {
    const { db } = d1();
    expect(await db.prepare("SELECT ? AS a, ? AS b").bind(true, false).first()).toEqual({ a: 1, b: 0 });
    expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow(/D1_TYPE_ERROR/);
    expect(() => db.prepare("SELECT ?").bind({})).toThrow(/D1_TYPE_ERROR/);
  });

  it("an UPDATE that matches nothing reports 0 changes", async () => {
    const { db } = d1();
    await db.prepare("INSERT INTO t (name) VALUES ('a')").run();
    expect((await db.prepare("UPDATE t SET name = 'z' WHERE id = 99").run()).meta.changes).toBe(0);
  });

  it("batch rolls back every statement when one fails, and takes only its own statements", async () => {
    const { db } = d1();
    await expect(db.batch([db.prepare("INSERT INTO t (name) VALUES ('x')"), db.prepare("INSERT INTO t (name) VALUES ('x')")])).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    expect((await db.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())?.n).toBe(0);
    const other = d1().db;
    await expect(db.batch([other.prepare("SELECT 1")])).rejects.toThrow(/this database only/);
    expect(await db.batch([])).toEqual([]);
    // The connection is usable after a failed batch (no transaction left open).
    expect((await db.prepare("INSERT INTO t (name) VALUES ('y')").run()).meta.changes).toBe(1);
  });

  it("changes() inside a batch sees the previous statement, as D1 does", async () => {
    const { db } = d1();
    await db.prepare("CREATE TABLE log (what TEXT)").run();
    const batch = () =>
      db.batch([
        db.prepare("INSERT INTO t (name) SELECT 'once' WHERE NOT EXISTS (SELECT 1 FROM t WHERE name = 'once')"),
        db.prepare("INSERT INTO log (what) SELECT 'added' WHERE changes() = 1"),
      ]);
    const [ins, logged] = await batch();
    expect([ins?.meta.changes, logged?.meta.changes]).toEqual([1, 1]);
    const [again, notLogged] = await batch();
    expect([again?.meta.changes, notLogged?.meta.changes]).toEqual([0, 0]);
    expect((await db.prepare("SELECT count(*) AS n FROM log").first<{ n: number }>())?.n).toBe(1);
  });

  it("runs the real access store over the real migrations (numbered ?1 parameters, conditional audit rows)", async () => {
    const raw = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    applyMigrations(raw);
    const access = openAccessStore(new NodeD1Database(raw) as unknown as D1Database);
    expect(await access.bootstrap("ann@corp.test", "u1")).toBe(true);
    expect(await access.bootstrap("bob@corp.test", "u2"), "bootstrap only while the list is empty").toBe(false);
    expect(await access.roleFor("ann@corp.test")).toBe("admin");
    expect(raw.prepare("SELECT action, pattern FROM access_audit").all().map((r) => ({ ...r }))).toEqual([{ action: "add", pattern: "ann@corp.test" }]);
    await expect(access.remove("ann@corp.test", { actor: "u1", via: "web" })).rejects.toSatisfy(isGwsError);
    expect((await access.add({ pattern: "@corp.test", role: "user" }, { actor: "u1", via: "web" })).outcome).toBe("added");
    // A batch with DELETE ... RETURNING statements; their rows come back in `results`.
    const removed = await access.remove("@corp.test", { actor: "u1", via: "web" });
    expect(removed?.rule.pattern).toBe("@corp.test");
    expect(raw.prepare("SELECT action, pattern FROM access_audit ORDER BY rowid").all().map((r) => `${String(r.action)} ${String(r.pattern)}`)).toEqual([
      "add ann@corp.test",
      "add @corp.test",
      "remove @corp.test",
    ]);
  });
});

function kv(now: { t: number }) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(KV_TABLE_SQL);
  return { raw, ns: new NodeKvNamespace(raw, "NS", () => now.t), other: new NodeKvNamespace(raw, "OTHER", () => now.t) };
}

describe("KV shim", () => {
  it("get returns text, json, arrayBuffer and stream; namespaces are separate", async () => {
    const { ns, other } = kv({ t: 1_000_000 });
    await ns.put("k", JSON.stringify({ a: 1 }));
    expect(await ns.get("k")).toBe('{"a":1}');
    expect(await ns.get("k", "json")).toEqual({ a: 1 });
    expect(await ns.get("k", { type: "json" })).toEqual({ a: 1 });
    expect(new TextDecoder().decode((await ns.get("k", "arrayBuffer")) as ArrayBuffer)).toBe('{"a":1}');
    expect(await new Response((await ns.get("k", "stream")) as ReadableStream).text()).toBe('{"a":1}');
    expect(await other.get("k")).toBeNull();
    expect(await ns.getWithMetadata("missing")).toEqual({ value: null, metadata: null, cacheStatus: null });
    await ns.delete("k");
    expect(await ns.get("k")).toBeNull();
  });

  it("expires entries by expirationTtl and expiration, and refuses KV's invalid expiries", async () => {
    const now = { t: 1_000_000_000 };
    const { raw, ns } = kv(now);
    await ns.put("ttl", "v", { expirationTtl: 60 });
    await ns.put("abs", "v", { expiration: now.t / 1000 + 120 });
    await expect(ns.put("short", "v", { expirationTtl: 59 })).rejects.toThrow(/at least 60/);
    await expect(ns.put("past", "v", { expiration: now.t / 1000 + 10 })).rejects.toThrow(/at least 60/);
    now.t += 60_000;
    expect(await ns.get("ttl")).toBeNull();
    expect(raw.prepare("SELECT count(*) AS n FROM node_kv WHERE key = 'ttl'").get()?.n, "an expired read removes the row").toBe(0);
    expect(await ns.get("abs")).toBe("v");
    expect((await ns.list()).keys.map((k) => k.name)).toEqual(["abs"]);
    now.t += 60_000;
    expect((await ns.list()).keys).toHaveLength(0);
    expect(sweepExpiredKv(raw, now.t), "the sweep removes `abs`, which no read touched").toBe(1);
  });

  it("an overwrite clears or replaces the expiry", async () => {
    const now = { t: 1_000_000_000 };
    const { ns } = kv(now);
    await ns.put("k", "short", { expirationTtl: 60 });
    await ns.put("k", "forever");
    now.t += 120_000;
    expect(await ns.get("k")).toBe("forever");
  });

  it("sweeps expired entries of every namespace in bounded passes", async () => {
    const now = { t: 1_000_000_000 };
    const { raw, ns, other } = kv(now);
    for (let i = 0; i < 1500; i++) await ns.put(`a${i}`, "v", { expirationTtl: 60 });
    for (let i = 0; i < 10; i++) await other.put(`b${i}`, "v", { expirationTtl: 60 });
    await ns.put("keep", "v");
    expect(sweepKv(raw, now.t), "nothing has expired yet").toBe(0);
    expect(sweepKv(raw, now.t + 60_000)).toBe(1510);
    expect(raw.prepare("SELECT key FROM node_kv").all().map((r) => r.key)).toEqual(["keep"]);
  });

  it("list pages by prefix with cursor, sorted, with metadata and expiration", async () => {
    const { ns } = kv({ t: 1_000_000 });
    for (const k of ["grant:u:3", "grant:u:1", "grant:v:1", "token:u:1", "grant:u:2"]) await ns.put(k, "x", { metadata: { k } });
    await ns.put("grant:u:9", "x", { expirationTtl: 3600 });
    const p1 = await ns.list({ prefix: "grant:u:", limit: 2 });
    expect(p1.keys.map((k) => k.name)).toEqual(["grant:u:1", "grant:u:2"]);
    expect(p1.keys[0]?.metadata).toEqual({ k: "grant:u:1" });
    expect(p1.list_complete).toBe(false);
    const p2 = await ns.list({ prefix: "grant:u:", limit: 2, cursor: p1.cursor ?? null });
    expect(p2.keys.map((k) => k.name)).toEqual(["grant:u:3", "grant:u:9"]);
    expect(p2.keys[1]?.expiration).toBe(1000 + 3600);
    expect(p2.keys[1]?.metadata).toBeUndefined();
    expect(p2.list_complete, "the last full page needs no further call").toBe(true);
    expect(p2.cursor).toBeUndefined();
    expect((await ns.list({ prefix: "grant:" })).keys).toHaveLength(5);
  });

  it("holds every KV call workers-oauth-provider makes, in its shapes, through a grant's whole life", async () => {
    const now = { t: 1_700_000_000_000 };
    const s = () => Math.floor(now.t / 1000);
    const { ns } = kv(now);
    const get = (k: string) => ns.get(k, { type: "json" });
    // Registration: a client record with no expiry.
    await ns.put("client:c1", JSON.stringify({ clientId: "c1" }));
    // Consent: the grant with the code, 10 minutes, its key metadata naming the client.
    await ns.put("grant:u:g1", JSON.stringify({ id: "g1" }), { expirationTtl: 600, metadata: { clientId: "c1" } });
    // Another user whose id starts with ours (`u:x`), as the provider's own-key filter expects to see and skip.
    await ns.put("grant:u:x:g9", JSON.stringify({ id: "g9" }), { metadata: { clientId: "c1" } });
    expect((await ns.list({ prefix: "grant:u:" })).keys.map((k) => [k.name, k.expiration, k.metadata])).toEqual([
      ["grant:u:g1", s() + 600, { clientId: "c1" }],
      ["grant:u:x:g9", undefined, { clientId: "c1" }],
    ]);
    // Code exchange: an access token for an hour, the grant re-saved with the refresh token's absolute expiry.
    await ns.put("token:u:g1:t1", JSON.stringify({ id: "t1" }), { expirationTtl: 3600 });
    await ns.put("grant:u:g1", JSON.stringify({ id: "g1", refresh: true }), { expiration: s() + 30 * 86400, metadata: { clientId: "c1" } });
    expect(await get("grant:u:g1")).toEqual({ id: "g1", refresh: true });
    expect((await ns.list({ prefix: "grant:u:g1" })).keys[0]).toEqual({ name: "grant:u:g1", expiration: s() + 30 * 86400, metadata: { clientId: "c1" } });

    // An hour later the access token is gone (to get and to list); the grant and the client stay.
    now.t += 3600 * 1000;
    expect(await get("token:u:g1:t1")).toBeNull();
    expect((await ns.list({ prefix: "token:u:g1:" })).keys).toEqual([]);
    expect(await get("grant:u:g1")).not.toBeNull();
    // A grant listing pages with the cursor it was given, and only when one is given.
    for (let i = 2; i <= 5; i++) await ns.put(`grant:u:g${i}`, "{}", { metadata: { clientId: "c2" } });
    const seen: string[] = [];
    let page = await ns.list({ prefix: "grant:u:", limit: 2 });
    seen.push(...page.keys.map((k) => k.name));
    while (!page.list_complete) {
      page = await ns.list({ prefix: "grant:u:", limit: 2, cursor: page.cursor ?? "" });
      seen.push(...page.keys.map((k) => k.name));
    }
    expect(seen).toEqual(["grant:u:g1", "grant:u:g2", "grant:u:g3", "grant:u:g4", "grant:u:g5", "grant:u:x:g9"]);
    // Revocation: list the grant's tokens, delete them and the grant.
    await ns.put("token:u:g1:t2", "{}", { expirationTtl: 3600 });
    for (const k of (await ns.list({ prefix: "token:u:g1:" })).keys) await ns.delete(k.name);
    await ns.delete("grant:u:g1");
    expect([await get("token:u:g1:t2"), await get("grant:u:g1")]).toEqual([null, null]);

    // 30 days after the exchange the refresh grant is gone; the client record never expires.
    await ns.put("grant:u:g6", "{}", { expiration: s() + 30 * 86400, metadata: { clientId: "c1" } });
    now.t += 30 * 86400 * 1000;
    expect(await get("grant:u:g6")).toBeNull();
    expect(await get("client:c1")).toEqual({ clientId: "c1" });
    // KV's 60 s floor, which the provider guards itself (it clamps absolute expiries, refuses shorter token TTLs).
    await expect(ns.put("token:u:g2:t", "{}", { expirationTtl: 59 })).rejects.toThrow(/at least 60/);
    await expect(ns.put("grant:u:g2", "{}", { expiration: s() + 59 })).rejects.toThrow(/at least 60/);
  });

  it("enforces KV's key, metadata and list limits", async () => {
    const { ns } = kv({ t: 1_000_000 });
    await expect(ns.put("", "v")).rejects.toThrow(/non-empty/);
    await expect(ns.put("k".repeat(513), "v")).rejects.toThrow(/512 bytes/);
    await expect(ns.put("k", "v", { metadata: { x: "m".repeat(1100) } })).rejects.toThrow(/metadata/);
    await expect(ns.list({ limit: 1001 })).rejects.toThrow(/limit/);
  });
});

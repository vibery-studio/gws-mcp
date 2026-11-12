// The Node host's OAuth server and access command: the built bundle (`bundleNodeHost`, run with plain `node` as
// `npm run serve:node` runs it) over HTTP against an in-process fake Google. The shared conformance cases are the
// ones the Workers tests run against the Worker entry, with the same expected answers. The access list is seeded and
// changed only through `server.js access ...`, before the first boot and while the server runs.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, FakeGoogle, signIn } from "../../scripts/e2e/oauth-driver";
import { bundleNodeHost } from "../../scripts/node-host-bundle";
import { NodeKvNamespace } from "../../src/runtime/node/kv";
import { MAX_LOG_CHARS } from "../../src/runtime/node/log";
import { D1_MIGRATIONS, applyMigrations } from "../../src/runtime/node/migrations";
import { oauthConformance } from "../shared/oauth-conformance";
import { type FakeServer, type HostProcess, freePort, runCommand, runHost, startFakeGoogle, stopHost, testOnly } from "./helpers";

const OWNER = "owner@oauth-node.test";
const DOMAIN = "oauth-conformance.test";
const TOKEN_ENC_KEY = randomBytes(32).toString("base64");
const fakeSecrets = { adminToken: testOnly(), loginSecret: testOnly() };

let work: string;
let bundleDir: string;
let dbFile: string;
let base: string;
let hostEnv: Record<string, string>;
let fakeServer: FakeServer;
let fake: FakeGoogle;
let host: HostProcess;
let db: DatabaseSync;
let oauthKv: NodeKvNamespace;

/** `server.js access <args>` with the server's own configuration. */
const access = (...args: string[]) => runCommand(bundleDir, hostEnv, ["access", ...args]);

async function mustAccess(...args: string[]): Promise<string> {
  const r = await access(...args);
  if (r.code !== 0) throw new Error(`access ${args[0]} exited ${r.code}: ${r.stderr}`);
  return r.stdout;
}

function audit(pattern: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT actor, via, action, pattern_kind, pattern, role FROM access_audit WHERE pattern = ? ORDER BY ts, rowid").all(pattern).map((r) => ({ ...r }));
}

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "gws-node-oauth-"));
  bundleDir = path.join(work, "app");
  await bundleNodeHost(bundleDir);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  fakeServer = await startFakeGoogle(fakeSecrets, [`${base}/google/callback`]);
  fake = new FakeGoogle(fakeServer.origin, fakeSecrets);

  dbFile = path.join(work, "data", "gws-mcp.db");
  mkdirSync(path.dirname(dbFile), { mode: 0o700 });
  const secretsFile = path.join(work, "secrets.env");
  writeFileSync(secretsFile, `TOKEN_ENC_KEY=${TOKEN_ENC_KEY}\n`, { mode: 0o600 });
  hostEnv = {
    GOOGLE_UPSTREAM: "fake",
    GOOGLE_SCOPE_PRESET: "narrow",
    PUBLIC_BASE_URL: base,
    FAKE_GOOGLE_PUBLIC_URL: fakeServer.origin,
    GWS_HOST: "127.0.0.1",
    GWS_PORT: String(port),
    GWS_DB_FILE: dbFile,
    GWS_SECRETS_FILE: secretsFile,
    // The tests play the trusted proxy, setting (never passing through) x-real-ip, so each AI app request can come
    // from its own address (below).
    GWS_TRUSTED_PROXIES: "127.0.0.1",
    GWS_CLIENT_IP_HEADER: "x-real-ip",
  };

  // The owner, before the first boot: the database does not exist yet.
  expect(await mustAccess("add", OWNER, "--admin")).toBe(`added ${OWNER} as admin\n`);
  host = runHost(bundleDir, hostEnv);
  await host.waitFor("listening", 30_000);

  db = new DatabaseSync(dbFile);
  db.exec("PRAGMA busy_timeout = 5000");
  oauthKv = new NodeKvNamespace(db, "OAUTH_KV");
}, 120_000);

afterAll(async () => {
  db?.close();
  if (host) await stopHost(host);
  await fakeServer?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

oauthConformance("the Node host", () => ({
  base,
  // Each AI app request from its own client address, as separate apps would send them: the suite registers more
  // clients than one address may per minute (the per-address limits have their own tests).
  fetch: (p, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-real-ip", `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join(".")}`);
    return fetch(new URL(p, base), { ...init, headers, redirect: "manual" });
  },
  async signIn(email) {
    await fake.seed({ accounts: [{ email, sub: `8${Date.now()}${Math.floor(Math.random() * 1e6)}`, preset: "default" }] });
    const browser = new Browser(base);
    await signIn(browser, fake, email);
    return browser;
  },
  async allow(email) {
    await mustAccess("add", email);
  },
  async remove(email) {
    await mustAccess("remove", email);
  },
  oauthKv,
  domain: DOMAIN,
}));

describe("the Node host's access command", () => {
  it("seeds the owner before the first boot with the audit row setup writes on Workers, and lists the rules", async () => {
    expect(audit(OWNER)).toEqual([{ actor: "setup", via: "setup", action: "add", pattern_kind: "email", pattern: OWNER, role: "admin" }]);
    const listed = await access("list");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`admin ${OWNER}\n`);
  });

  it("lets a person in on the running server as soon as their rule is added", async () => {
    const email = `late-${crypto.randomUUID().slice(0, 8)}@later.test`;
    await fake.seed({ accounts: [{ email, sub: `7${Date.now()}`, preset: "default" }] });
    await expect(signIn(new Browser(base), fake, email)).rejects.toThrow(/403/);
    await mustAccess("add", email);
    const browser = new Browser(base);
    await signIn(browser, fake, email);
    const accounts = await browser.fetch("/accounts");
    expect(accounts.status).toBe(200);
    expect(await accounts.text()).toContain(email);
  }, 30_000);

  it("adds rules, and on an existing rule changes only the role or note given, with one audit row per access change", async () => {
    expect(await mustAccess("add", " Ops@Node-Admin.TEST ", "--note", "on-call\u202e team")).toBe("added ops@node-admin.test as user\n");
    expect(await mustAccess("add", "ops@node-admin.test")).toBe("ops@node-admin.test is already user; nothing changed\n");
    expect(await mustAccess("add", "ops@node-admin.test", "--admin")).toBe("ops@node-admin.test: role user -> admin\n");
    // Re-running a seed line without the flag keeps the admin.
    expect(await mustAccess("add", "ops@node-admin.test")).toBe("ops@node-admin.test is already admin; nothing changed\n");
    expect(await mustAccess("list")).toContain("admin ops@node-admin.test (on-call  team)\n");
    expect(await mustAccess("add", "ops@node-admin.test", "--note", "pager")).toBe("ops@node-admin.test: note updated\n");
    expect(await mustAccess("add", "ops@node-admin.test", "--note", "pager", "--admin")).toBe("ops@node-admin.test is already admin; nothing changed\n");
    expect(await mustAccess("add", "ops@node-admin.test", "--no-admin", "--note", "ops")).toBe("ops@node-admin.test: role admin -> user; note updated\n");
    expect(await mustAccess("list")).toContain("user  ops@node-admin.test (ops)\n");
    expect(await mustAccess("remove", "ops@node-admin.test")).toBe("removed ops@node-admin.test; people who lost access: 0; AI apps cut off: 0\n");
    expect(audit("ops@node-admin.test").map((r) => [r.actor, r.via, r.action, r.role])).toEqual([
      ["setup", "setup", "add", "user"],
      ["setup", "setup", "role", "admin"],
      ["setup", "setup", "role", "user"],
      ["setup", "setup", "remove", "user"],
    ]);
    expect(await mustAccess("add", "@Node-Domain.test")).toBe("added @node-domain.test as user\n");
    expect(audit("@node-domain.test")).toMatchObject([{ action: "add", pattern_kind: "domain", role: "user" }]);
  }, 60_000);

  it("refuses what the access page refuses (exit 1), changing nothing", async () => {
    const before = db.prepare("SELECT count(*) AS n FROM access_audit").get()?.n;
    for (const [args, message] of [
      [["add", "not an email"], "refused: pattern must be an email (name@example.com) or a domain (@example.com)"],
      [["add", "ünï@example.test"], "refused: pattern must be an email"],
      [["add", "x@y.test", "--note", "n".repeat(201)], "refused: note must be text of at most 200 characters"],
      [["add", OWNER, "--note", "n".repeat(201)], "refused: note must be text of at most 200 characters"],
      [["remove", OWNER], "refused: the last admin cannot be removed or made a user; add another admin first"],
      [["add", OWNER, "--no-admin"], "refused: the last admin cannot be removed or made a user"],
      [["remove", "nobody@node-admin.test"], "no such rule in the access list; nothing changed"],
    ] as const) {
      const r = await access(...args);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.stderr).toContain(message);
      expect(r.stdout).toBe("");
    }
    expect(db.prepare("SELECT count(*) AS n FROM access_audit").get()?.n).toBe(before);
    expect(db.prepare("SELECT count(*) AS n FROM access_rules WHERE pattern = 'x@y.test'").get()?.n).toBe(0);
    expect(await mustAccess("list")).toContain(`admin ${OWNER}\n`);
  }, 60_000);

  it("answers a malformed command with its usage (64) and a configuration problem with 78, and needs no secret", async () => {
    for (const args of [
      ["access"],
      ["access", "add"],
      ["access", "list", "extra"],
      ["access", "add", "a@b.test", "--role", "admin"],
      ["access", "add", "a@b.test", "--admin", "--no-admin"],
      ["access", "remove", "a@b.test", "--admin"],
      ["accesss"],
    ]) {
      const r = await runCommand(bundleDir, hostEnv, args);
      expect({ args, code: r.code }).toEqual({ args, code: 64 });
      expect(r.stderr).toContain("usage:");
    }
    const { GWS_DB_FILE: _db, GWS_SECRETS_FILE: _secrets, ...noDb } = hostEnv;
    const missing = await runCommand(bundleDir, noDb, ["access", "list"]);
    expect(missing.code).toBe(78);
    expect(missing.stderr).toContain("configuration error: invalid config: GWS_DB_FILE");
    // No TOKEN_ENC_KEY, no Google client, no secrets file: the command uses none of them.
    const { GWS_SECRETS_FILE: _s, ...noSecrets } = hostEnv;
    const listed = await runCommand(bundleDir, { ...noSecrets, GOOGLE_UPSTREAM: "google", FAKE_GOOGLE_PUBLIC_URL: "" }, ["access", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`admin ${OWNER}\n`);
    for (const r of [missing, listed, await access("list")]) {
      for (const secret of [TOKEN_ENC_KEY, fakeSecrets.adminToken, fakeSecrets.loginSecret]) expect(`${r.stdout}${r.stderr}`).not.toContain(secret);
    }
  }, 60_000);

  it("never migrates an existing database: one missing this build's migrations or migrated by a newer build is refused (78)", async () => {
    const older = path.join(work, "data", "older.db");
    const newer = path.join(work, "data", "newer.db");
    for (const [file, migrations] of [
      [older, D1_MIGRATIONS.slice(0, -1)],
      [newer, D1_MIGRATIONS],
    ] as const) {
      const d = new DatabaseSync(file);
      applyMigrations(d, migrations);
      if (file === newer) d.prepare("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')").run();
      d.close();
    }
    const last = D1_MIGRATIONS.at(-1)?.name ?? "";
    for (const [file, message] of [
      [older, `refused: the database lacks this version's migrations (${last}); start the server of this version first`],
      [newer, "refused: the database was migrated by a newer gws-mcp (9999_future.sql); use the command of that version"],
    ] as const) {
      for (const args of [["list"], ["add", "new@node-admin.test", "--admin"]]) {
        const r = await runCommand(bundleDir, { ...hostEnv, GWS_DB_FILE: file }, ["access", ...args]);
        expect({ file: path.basename(file), args, code: r.code }).toEqual({ file: path.basename(file), args, code: 78 });
        expect(r.stderr).toContain(message);
      }
      const d = new DatabaseSync(file, { readOnly: true });
      const names = d.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => r.name);
      const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('node_kv', 'access_rules', 'approvals')").all().map((r) => r.name);
      d.close();
      expect(names).toEqual(file === older ? D1_MIGRATIONS.slice(0, -1).map((m) => m.name) : [...D1_MIGRATIONS.map((m) => m.name), "9999_future.sql"]);
      expect(tables.sort()).toEqual(file === older ? ["access_rules"] : ["access_rules", "approvals"]);
    }
  }, 60_000);

  it("answers a busy database with a plain message and 75, and an internal failure with 70, never a stack", async () => {
    const holder = new DatabaseSync(dbFile);
    holder.exec("BEGIN IMMEDIATE");
    let busy;
    try {
      busy = await access("add", "busy@node-admin.test");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(busy.code).toBe(75);
    expect(busy.stderr).toContain("the database is busy (another process is writing to it); nothing changed; try again");
    expect(busy.stderr).not.toMatch(/\n\s+at /);
    expect(db.prepare("SELECT count(*) AS n FROM access_rules WHERE pattern = 'busy@node-admin.test'").get()?.n).toBe(0);

    // A file that is not a database.
    const junk = path.join(work, "data", "junk.db");
    writeFileSync(junk, "not a database, just text that is long enough to be read as a header", { mode: 0o600 });
    const failed = await runCommand(bundleDir, { ...hostEnv, GWS_DB_FILE: junk }, ["access", "list"]);
    expect(failed.code).toBe(70);
    expect(failed.stderr).toMatch(/^failed: /m);
    expect(failed.stderr).not.toMatch(/\n\s+at /);
    expect(failed.stderr).not.toContain("startup failed");
  }, 60_000);
});

describe("the Node host's logs", () => {
  /** Host output lines after `from`, each of which must be one JSON object. */
  function linesSince(from: number): Array<Record<string, unknown>> {
    return host.lines.slice(from).map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("are JSON lines only: request text a dependency logs cannot forge a line, and the CIMD notice is plain", async () => {
    const from = host.lines.length;
    const forged = JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "FORGED-LINE" });
    const key = encodeURIComponent(`x\n${forged}\n\u2028`);
    const res = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `${key}=1&${key}=2` });
    await res.body?.cancel();
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    const hits = host.lines.slice(from).filter((l) => l.includes("FORGED-LINE"));
    expect(hits).toHaveLength(1);
    const hit = JSON.parse(hits[0] ?? "") as Record<string, unknown>;
    expect(hit).toMatchObject({ level: "warn", msg: "console" });
    expect(String(hit.message)).toContain(forged);
    expect(hits[0]).not.toMatch(/[\n\u2028\u2029]/);

    // Every line the host ever wrote is one JSON object: the boot, the provider's CIMD notice, the requests.
    const all = host.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(all.every((l) => typeof l.ts === "string" && typeof l.level === "string" && typeof l.msg === "string")).toBe(true);
    expect(host.lines.join("\n")).not.toContain("wrangler.jsonc");
    expect(all.filter((l) => String(l.msg).startsWith("client ID metadata documents (CIMD) are off"))).toHaveLength(1);
    // Both proxy settings are given here, so no proxy-trust warning.
    expect(all.filter((l) => /GWS_TRUSTED_PROXIES|GWS_CLIENT_IP_HEADER/.test(String(l.msg)))).toEqual([]);
  });

  it("writes at most one capped line for a request the provider fails on (an overlong client id: 500, as on Workers)", async () => {
    const from = host.lines.length;
    for (const target of ["/authorize", "/oauth/token"]) {
      const q = new URLSearchParams({ response_type: "code", grant_type: "authorization_code", code: "u:g:s", client_id: "c".repeat(600), redirect_uri: "https://x.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
      const res = target === "/authorize" ? await fetch(`${base}${target}?${q.toString()}`, { redirect: "manual" }) : await fetch(`${base}${target}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: q.toString() });
      await res.body?.cancel();
      expect(res.status).toBe(500);
    }
    await new Promise((r) => setTimeout(r, 300));
    const lines = linesSince(from);
    expect(lines.filter((l) => l.msg === "the Worker fetch threw")).toHaveLength(1);
    for (const l of host.lines.slice(from)) expect(l.length).toBeLessThan(3 * MAX_LOG_CHARS);
  });
});

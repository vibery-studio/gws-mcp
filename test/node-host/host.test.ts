// The built Node host end to end: `bundleNodeHost` output run with plain `node` as a child process (what
// `npm run serve:node` runs), against an in-process fake Google. Covers sign-in through the access allowlist, an
// MCP client's OAuth token, tools/list and an execute read over Streamable HTTP, refresh, revocation, removing an
// app, and a clean SIGTERM shutdown.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpSession, rawToolsList } from "../../scripts/e2e/mcp";
import { Browser, CLIENT_REDIRECT, FakeGoogle, approveClient, formFields, openConsent, registerClient, signIn } from "../../scripts/e2e/oauth-driver";
import { WASM_FILE, bundleNodeHost } from "../../scripts/node-host-bundle";
import { type FakeServer, type HostProcess, freePort, runHost, startFakeGoogle, stopHost, testOnly } from "./helpers";

const DOMAIN = "corp.test";
const USER = `alice@${DOMAIN}`;
const OUTSIDER = "mallory@outside.test";
const TOKEN_ENC_KEY = randomBytes(32).toString("base64");
const fakeSecrets = { adminToken: testOnly(), loginSecret: testOnly() };

let work: string;
let bundleDir: string;
let dbFile: string;
let base: string;
let fakeServer: FakeServer;
let fake: FakeGoogle;
let host: HostProcess;

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "gws-node-host-e2e-"));
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

  host = runHost(bundleDir, {
    GOOGLE_UPSTREAM: "fake",
    GOOGLE_SCOPE_PRESET: "narrow",
    PUBLIC_BASE_URL: base,
    FAKE_GOOGLE_PUBLIC_URL: fakeServer.origin,
    GWS_HOST: "127.0.0.1",
    GWS_PORT: String(port),
    GWS_DB_FILE: dbFile,
    GWS_SECRETS_FILE: secretsFile,
  });
  await host.waitFor("listening", 30_000);

  // The access allowlist, written by a second connection as an operator command would: one domain rule.
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    db.prepare("INSERT INTO access_rules (pattern, role, note, created_by, created_at) VALUES (?, 'user', NULL, 'setup', ?)").run(`@${DOMAIN}`, now);
    db.prepare("INSERT INTO access_audit (id, ts, actor, via, action, pattern_kind, pattern, role) VALUES (?, ?, 'setup', 'setup', 'add', 'domain', ?, 'user')").run(
      crypto.randomUUID(),
      now,
      `@${DOMAIN}`,
    );
  } finally {
    db.close();
  }
  await fake.seed({ accounts: [USER, OUTSIDER].map((email, i) => ({ email, sub: `9${Date.now()}${i}`, preset: "default" })) });
}, 120_000);

afterAll(async () => {
  if (host) await stopHost(host);
  await fakeServer?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("the bundled Node host", () => {
  it("ships the bundle, the sandbox thread and the QuickJS wasm side by side", () => {
    for (const f of ["server.js", "sandbox-worker.js", WASM_FILE, "package.json"]) expect(existsSync(path.join(bundleDir, f)), f).toBe(true);
  });

  it("boots with the D1 migrations applied, an owner-only WAL database and no secret in its logs", async () => {
    const applied = await host.waitFor("migrations applied");
    expect(applied.migrations).toEqual(["0001_init.sql", "0002_client_approvals.sql", "0003_access_rules.sql", "0004_user_settings.sql", "0005_used_links.sql", "0006_approvals.sql"]);
    expect(statSync(dbFile).mode & 0o777).toBe(0o600);
    expect(existsSync(`${dbFile}-wal`)).toBe(true);
    const starting = await host.waitFor("starting");
    expect(starting).toMatchObject({ upstream: "fake", secrets: { TOKEN_ENC_KEY: "file" }, publicBaseUrl: base });
    // No trusted proxy is configured here: the boot says what that means behind a proxy.
    const warnings = host.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.level === "warn" && String(l.msg).startsWith("GWS_TRUSTED_PROXIES is not set"));
    expect(warnings).toHaveLength(1);
    const version = await fetch(`${base}/version`);
    expect(version.status).toBe(200);
    expect(((await version.json()) as { name: string }).name).toBe("gws-mcp");
  });

  it("signs in an allowed user and refuses an address outside the allowlist", async () => {
    const browser = new Browser(base);
    await signIn(browser, fake, USER);
    const accounts = await browser.fetch("/accounts");
    expect(accounts.status).toBe(200);
    expect(await accounts.text()).toContain(USER);

    const outsider = new Browser(base);
    await expect(signIn(outsider, fake, OUTSIDER)).rejects.toThrow(/403/);
    const page = await outsider.fetch("/accounts");
    await page.body?.cancel();
    expect(page.status).not.toBe(200);
  }, 30_000);

  it("issues an MCP token, lists tools and runs an execute read; refresh, revocation and app removal end access", async () => {
    const unauth = await rawToolsList(base);
    expect(unauth.status).toBe(401);
    expect(unauth.wwwAuthenticate).toContain(`resource_metadata="${base}/`);

    const browser = new Browser(base);
    await signIn(browser, fake, USER);
    const client = await approveClient(browser, "node-host-test", [USER]);
    const session = await McpSession.open(base, client.accessToken);
    try {
      expect(await session.toolNames()).toEqual(["execute", "search"]);
      const { out } = await session.execute(`async () => (await sdk.gmail.users.labels.list({ userId: "me" })).labels.length`);
      expect(out.error).toBeUndefined();
      expect(typeof out.result).toBe("number");
      expect(out.calls[0]).toMatchObject({ fn: "gmail.users.labels.list", status: "ok", account: USER });
      expect((await fake.requests(USER)).some((r) => r.path.includes("/gmail/v1/users/me/labels"))).toBe(true);
    } finally {
      await session.close();
    }

    // Refresh rotation and RFC 7009 revocation at the token endpoint, on a second client.
    const second = await registerClient(base, "node-host-test-2");
    const { page, verifier } = await openConsent(browser, second);
    const approved = await browser.postForm("/authorize", [
      ["handle", page.handle],
      ["csrf", page.csrf],
      ["decision", "approve"],
      ...page.accounts.filter((a) => a.label.startsWith(USER)).map((a): [string, string] => ["account", a.id]),
    ]);
    await approved.body?.cancel();
    const code = new URL(approved.headers.get("location") ?? "http://none.invalid").searchParams.get("code") ?? "";
    const token = (body: Record<string, string>, endpoint = "/oauth/token") =>
      fetch(`${base}${endpoint}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
    const first = (await (
      await token({ grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT, client_id: second, code_verifier: verifier, resource: `${base}/mcp` })
    ).json()) as Record<string, unknown>;
    expect(typeof first.access_token).toBe("string");
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: String(first.refresh_token), client_id: second, resource: `${base}/mcp` });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as Record<string, unknown>;
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expect((await rawToolsList(base, String(rotated.access_token))).status).toBe(200);

    const revoke = await token({ token: String(rotated.access_token), client_id: second });
    await revoke.body?.cancel();
    expect(revoke.status).toBe(200);
    expect((await rawToolsList(base, String(rotated.access_token))).status).toBe(401);

    // Removing the first app from the web UI (KV list with key metadata) revokes its grant.
    expect((await rawToolsList(base, client.accessToken)).status).toBe(200);
    const removePage = await browser.fetch(`/apps/${encodeURIComponent(client.clientId)}/remove`);
    const fields = formFields(await removePage.text(), "/connections/client-revoke");
    expect(fields).toBeDefined();
    const removed = await browser.postForm("/connections/client-revoke", fields ?? []);
    await removed.body?.cancel();
    expect(removed.status).toBe(303);
    expect((await rawToolsList(base, client.accessToken)).status).toBe(401);
  }, 60_000);

  it("stops cleanly on SIGTERM: exit 0, the database closed and checkpointed, no secret ever logged", async () => {
    const { code, signal } = await stopHost(host);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(host.lines.some((l) => l.includes('"msg":"stopped"'))).toBe(true);
    // The last connection's close checkpoints the WAL and removes it.
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      db.close();
    }
    const output = host.lines.join("\n");
    for (const secret of [TOKEN_ENC_KEY, fakeSecrets.adminToken, fakeSecrets.loginSecret]) expect(output).not.toContain(secret);
  }, 30_000);

  it("refuses to start without TOKEN_ENC_KEY, naming it, with exit code 78", async () => {
    const failed = runHost(bundleDir, {
      GOOGLE_UPSTREAM: "fake",
      PUBLIC_BASE_URL: base,
      FAKE_GOOGLE_PUBLIC_URL: fakeServer.origin,
      GWS_PORT: "0",
      GWS_DB_FILE: path.join(work, "unused.db"),
    });
    const { code } = await failed.exited;
    expect(code).toBe(78);
    expect(failed.lines.join("\n")).toContain("missing secret: TOKEN_ENC_KEY");
    expect(existsSync(path.join(work, "unused.db"))).toBe(false);
  }, 30_000);
});

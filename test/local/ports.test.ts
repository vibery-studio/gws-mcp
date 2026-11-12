import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProps } from "../../src/contracts";
import { createCallSession } from "../../src/core/dispatch";
import { runExecute } from "../../src/core/execute";
import { isGwsError } from "../../src/errors";
import { localPorts } from "../../src/local/ports";
import { LOCAL_USER_ID } from "../../src/local/store";
import { connectAtFake, localConfig, openLocal, stubFakeGoogle, tempDir } from "./helpers";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const AUTH: AuthProps = { userId: LOCAL_USER_ID, clientId: "local" };

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  vi.unstubAllGlobals();
});

async function local(upstream: "fake" | "google" = "fake") {
  const t = tempDir();
  const l = await openLocal(t.dir, upstream);
  cleanups.push(t.cleanup, () => l.store.close());
  return l;
}

describe("the local HTTP port (upstream derived from config)", () => {
  it("names the upstream its config names, in both modes", async () => {
    for (const mode of ["fake", "google"] as const) {
      const { store, secrets } = await local(mode);
      expect(localPorts({ config: localConfig({ GOOGLE_UPSTREAM: mode }), store, secrets }).http.upstream).toBe(mode);
    }
  });

  it("refuses a store whose database belongs to the other upstream, so stored real tokens never go to a fake", async () => {
    const { store, secrets } = await local("google");
    expect(() => localPorts({ config: localConfig({ GOOGLE_UPSTREAM: "fake" }), store, secrets })).toThrow(
      expect.objectContaining({ code: "GWS_INTERNAL", message: "the database belongs to the google upstream, but the config names fake" }),
    );
  });

  it("is refused by a session whose config names another upstream", async () => {
    const { store, secrets } = await local();
    const ports = localPorts({ config: localConfig({ GOOGLE_UPSTREAM: "fake" }), store, secrets });
    const sessionConfig = localConfig({ GOOGLE_UPSTREAM: "google" });
    expect(() => createCallSession({ ports, auth: AUTH, apply: false, executeId: "x-mismatch", config: sessionConfig })).toThrow(
      expect.objectContaining({ code: "GWS_INTERNAL", message: "the session config and the env disagree on the Google upstream" }),
    );
    const out = await runExecute({ code: "async () => 1", apply: false, auth: AUTH, ports, config: sessionConfig });
    expect(out).toMatchObject({ ok: false, error: { code: "GWS_INTERNAL" } });
  });

  it("in fake mode sends every request, the token refresh included, to the fake through ports.http.send", async () => {
    const fake = stubFakeGoogle();
    const { store, secrets } = await local();
    const config = localConfig();
    await connectAtFake(fake, config, store, "http-fake@fake.test", [DRIVE_FILE]);
    const ports = localPorts({ config, store, secrets });
    fake.seen.length = 0;
    const out = await runExecute({ code: "async () => (await sdk.drive.files.list({})).files", apply: false, auth: AUTH, ports, config });
    expect(out).toMatchObject({ ok: true, result: [] });
    expect(fake.seen).toEqual(["POST /oauth2.googleapis.com/token", "GET /www.googleapis.com/drive/v3/files"]);
  });

  it("in google mode sends to Google only, with the configured client, never to the fake", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      sent.push(`${req.method} ${url.origin}${url.pathname}`);
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        expect(form.get("client_id")).toBe("real-client.apps.googleusercontent.com");
        return Response.json({ access_token: "opaque-access-token-0001", expires_in: 3600, token_type: "Bearer" });
      }
      return Response.json({ files: [] });
    });
    const { store, secrets } = await local("google");
    await secrets.set("GOOGLE_CLIENT_ID", "real-client.apps.googleusercontent.com");
    await secrets.set("GOOGLE_CLIENT_SECRET", "GOCSPX-real-client-secret");
    const config = localConfig({ GOOGLE_UPSTREAM: "google" });
    await store.accounts.upsertConnected({ userId: LOCAL_USER_ID, email: "g@example.test", sub: "g-sub", scopes: [DRIVE_FILE], refreshToken: "opaque-refresh-token-0001" });
    const out = await runExecute({ code: "async () => (await sdk.drive.files.list({})).files", apply: false, auth: AUTH, ports: localPorts({ config, store, secrets }), config });
    expect(out).toMatchObject({ ok: true, result: [] });
    expect(sent).toEqual(["POST https://oauth2.googleapis.com/token", "GET https://www.googleapis.com/drive/v3/files"]);
  });
});

describe("the local approval port (one user, no client approval layer)", () => {
  it("allows every account of the user, lists them all, and refuses to remove one", async () => {
    const fake = stubFakeGoogle();
    const { store, secrets } = await local();
    const config = localConfig();
    const a = await connectAtFake(fake, config, store, "appr-a@fake.test", [DRIVE_FILE]);
    const b = await connectAtFake(fake, config, store, "appr-b@fake.test", [DRIVE_FILE]);
    const { approval } = localPorts({ config, store, secrets });
    expect(await approval.list(LOCAL_USER_ID, "any-client")).toEqual([a.account.id, b.account.id]);
    expect(await approval.isAllowed(LOCAL_USER_ID, "any-client", a.account.id)).toBe(true);
    expect(await approval.isAllowed(LOCAL_USER_ID, "any-client", "a_unknown")).toBe(false);
    expect(await approval.isAllowed("someone-else", "any-client", a.account.id)).toBe(false);
    const err = await approval.remove(LOCAL_USER_ID, "any-client", a.account.id).catch((e: unknown) => e);
    expect(isGwsError(err) && err.code).toBe("GWS_INVALID_INPUT");

    const out = await runExecute({ code: "async () => sdk.accounts.list({})", apply: false, auth: AUTH, ports: localPorts({ config, store, secrets }), config });
    expect(out).toMatchObject({ ok: true, result: { hiddenCount: 0, accounts: [{ email: "appr-a@fake.test" }, { email: "appr-b@fake.test" }] } });
  });
});

describe("local redaction of console output (every secret held, every token loaded)", () => {
  it("redacts the keychain secrets and non-Google-shaped tokens loaded from the store or sent upstream", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/token") return Response.json({ access_token: "opaque-access-token-0002", expires_in: 3600, token_type: "Bearer" });
      if (url.pathname === "/revoke") return new Response(null, { status: 200 });
      return Response.json({ files: [] });
    });
    const { store, secrets } = await local("google");
    await secrets.set("GOOGLE_CLIENT_ID", "client-id-0002.apps.googleusercontent.com");
    await secrets.set("GOOGLE_CLIENT_SECRET", "plain-client-secret-0002");
    const config = localConfig({ GOOGLE_UPSTREAM: "google" });
    await store.accounts.upsertConnected({ userId: LOCAL_USER_ID, email: "used@example.test", sub: "s-used", scopes: [DRIVE_FILE], refreshToken: "opaque-refresh-used-0002" });
    await store.accounts.upsertConnected({ userId: LOCAL_USER_ID, email: "gone@example.test", sub: "s-gone", scopes: [DRIVE_FILE], refreshToken: "opaque-refresh-gone-0002" });
    const ports = localPorts({ config, store, secrets });
    const key = secrets.source.get("TOKEN_ENC_KEY") ?? "";

    // Loads the first account's refresh token and mints an access token; disconnecting the second sends its token.
    const first = await runExecute({ code: "async () => sdk.drive.files.list({ account: 'used@example.test' })", apply: false, auth: AUTH, ports, config });
    expect(first.ok).toBe(true);
    const disconnect = await runExecute({ code: "async () => sdk.accounts.disconnect({ account: 'gone@example.test' })", apply: true, auth: AUTH, ports, config });
    expect(disconnect).toMatchObject({ ok: true });

    const leaks = [key, "plain-client-secret-0002", "opaque-refresh-used-0002", "opaque-access-token-0002", "opaque-refresh-gone-0002"];
    const code = `async () => { const v = ${JSON.stringify(leaks)}; console.log(v.join(" ")); throw new Error("ended: " + v.join(" ")); }`;
    const out = await runExecute({ code, apply: false, auth: AUTH, ports, config });
    const redacted = leaks.map(() => "[REDACTED]").join(" ");
    expect(out.logs).toEqual([redacted]);
    expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: `ended: ${redacted}` });
    expect(JSON.stringify(out)).not.toMatch(/opaque-|plain-client-secret/);
  });
});

describe("local Google Ads settings", () => {
  const ADWORDS = "https://www.googleapis.com/auth/adwords";

  it("sends the saved values only as Google Ads headers, and redacts the developer token (not the login customer id) from every later line", async () => {
    const seen: Array<{ host: string; token: string | null; login: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/token") return Response.json({ access_token: "opaque-access-token-0003", expires_in: 3600, token_type: "Bearer" });
      seen.push({ host: url.hostname, token: req.headers.get("developer-token"), login: req.headers.get("login-customer-id") });
      return url.hostname === "googleads.googleapis.com" ? Response.json({ resourceNames: ["customers/5550002222"] }) : Response.json({ files: [] });
    });
    const { store, secrets } = await local("google");
    await secrets.set("GOOGLE_CLIENT_ID", "client-id-0003.apps.googleusercontent.com");
    await secrets.set("GOOGLE_CLIENT_SECRET", "plain-client-secret-0003");
    const config = localConfig({ GOOGLE_UPSTREAM: "google" });
    await store.accounts.upsertConnected({ userId: LOCAL_USER_ID, email: "ads@example.test", sub: "s-ads", scopes: [ADWORDS, DRIVE_FILE], refreshToken: "opaque-refresh-ads-0003" });
    const base = localPorts({ config, store, secrets });
    // Everything that crosses into the sandbox, recorded raw, before any redaction of the output.
    const crossed: string[] = [];
    const ports = {
      ...base,
      sandbox: {
        normalize: base.sandbox.normalize,
        run: (req: Parameters<typeof base.sandbox.run>[0]) =>
          base.sandbox.run({
            ...req,
            call: async (name, input) => {
              const r = await req.call(name, input);
              crossed.push(JSON.stringify(r));
              return r;
            },
          }),
      },
    };

    const missing = await runExecute({ code: "async () => sdk.googleads.customers.listAccessibleCustomers({})", apply: false, auth: AUTH, ports, config });
    expect(missing.error?.code).toBe("GWS_ADS_DEVELOPER_TOKEN_MISSING");
    // No web page locally, so no one-time link either.
    expect(missing.error?.details).toEqual({ setting: "ads.developer_token" });
    expect(seen).toEqual([]);

    await store.settings.set(LOCAL_USER_ID, "ads.developer_token", "FAKE-local-dev-token-0003");
    await store.settings.set(LOCAL_USER_ID, "ads.login_customer_id", "555-000-2222");
    const out = await runExecute({
      code: "async () => { const r = await sdk.googleads.customers.listAccessibleCustomers({}); await sdk.drive.files.list({}); return r; }",
      apply: false,
      auth: AUTH,
      ports,
      config,
    });
    // Checked first, on the raw traffic: the output below is redacted and could not show a leak.
    expect(crossed.join("\n")).not.toContain("FAKE-local-dev-token-0003");
    expect(out).toMatchObject({ ok: true, result: { resourceNames: ["customers/5550002222"] } });
    expect(seen).toEqual([
      { host: "googleads.googleapis.com", token: "FAKE-local-dev-token-0003", login: "5550002222" },
      { host: "www.googleapis.com", token: null, login: null },
    ]);
    // The process redactor (CLI lines, the sandbox's console) knows the developer token now; the account number stays.
    expect(secrets.redactor.redact("t=FAKE-local-dev-token-0003 l=5550002222")).toBe("t=[REDACTED] l=5550002222");

    // A saved value that no longer decrypts gives a structured error naming it, and nothing is sent.
    const raw = new DatabaseSync(store.path);
    raw.prepare("UPDATE user_settings SET value_ct = ? WHERE key = 'ads.login_customer_id'").run("A".repeat(40));
    raw.close();
    seen.length = 0;
    const unreadable = await runExecute({ code: "async () => sdk.googleads.customers.listAccessibleCustomers({})", apply: false, auth: AUTH, ports, config });
    expect([unreadable.error?.code, unreadable.error?.details]).toEqual(["GWS_SETTING_UNREADABLE", { setting: "ads.login_customer_id" }]);
    expect(seen).toEqual([]);
  });
});

describe("local one-time setting links", () => {
  it("are refused with GWS_UNSUPPORTED_RUNTIME pointing to the CLI, and the settings.set refusal offers none", async () => {
    const { store, secrets } = await local();
    const config = localConfig();
    const ports = localPorts({ config, store, secrets });
    const link = await runExecute({ code: 'async () => sdk.settings.requestLink({ key: "ads.login_customer_id" })', apply: false, auth: AUTH, ports, config });
    expect(link.error).toEqual({
      code: "GWS_UNSUPPORTED_RUNTIME",
      message: expect.stringContaining("`gws-mcp settings set ads.login_customer_id`"),
      fn: "settings.requestLink",
      details: { setting: "ads.login_customer_id" },
    });
    const refused = await runExecute({ code: 'async () => sdk.settings.set({ key: "ads.developer_token", value: "x" })', apply: false, auth: AUTH, ports, config });
    expect([refused.error?.code, refused.error?.details]).toEqual(["GWS_INVALID_INPUT", { reason: "set_outside_ai_app" }]);
    const raw = new DatabaseSync(store.path);
    const { n } = raw.prepare("SELECT count(*) AS n FROM links").get() as { n: number };
    raw.close();
    expect(n).toBe(0);
  });

  it("share the remote schema: the used-links table exists and every save and clear moves the settings version", async () => {
    const { store } = await local();
    const raw = new DatabaseSync(store.path);
    const table = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'used_links'").get();
    raw.close();
    expect(table).toEqual({ name: "used_links" });
    const before = await store.settings.version(LOCAL_USER_ID);
    await store.settings.set(LOCAL_USER_ID, "ads.login_customer_id", "555-000-3333");
    await store.settings.clear(LOCAL_USER_ID, "ads.login_customer_id");
    expect(await store.settings.version(LOCAL_USER_ID)).toBe(before + 2);
  });
});

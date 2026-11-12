import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCESS_CACHE_MS, forgetAccessCache, removeRuleAndRevoke } from "../../src/auth/access";
import { providerOptions } from "../../src/auth/provider-options";
import { mcpApiHandler } from "../../src/mcp/server";
import { openAccessStore } from "../../src/store/access";
import { openStore } from "../../src/store/db";
import { webApp } from "../../src/web/app";
import { seedUserWithAccount } from "../helpers/accounts";
import { mintMcpToken } from "../helpers/mcp-token";

/** The access list on the MCP side: every request rechecks the user's rule, and `access.*` manage the list. */

const G = "https://www.googleapis.com/auth/";
const access = openAccessStore(env.DB);
const SETUP = { actor: "u_test", via: "web" as const };
const providerConfig = { ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp };
const envWithProvider = () => ({ ...env, OAUTH_PROVIDER: getOAuthApi(providerConfig, env) }) as Env;

let seq = 0;

async function rpc(method: string, params: Record<string, unknown>, token: string): Promise<{ status: number; body: string }> {
  const res = await exports.default.fetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      host: "localhost",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  return { status: res.status, body: await res.text() };
}

async function execute(token: string, code: string, apply = false): Promise<{ isError: boolean; value: Record<string, unknown> }> {
  const r = await rpc("tools/call", { name: "execute", arguments: { code, apply } }, token);
  const line = r.body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .at(-1);
  const message = JSON.parse(line ?? r.body) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
  const text = message.result?.content?.[0]?.text;
  if (text === undefined) throw new Error(`no tool result: ${r.status} ${r.body.slice(0, 300)}`);
  return { isError: message.result?.isError === true, value: JSON.parse(text) as Record<string, unknown> };
}

/** A user with one account, allowed by an exact rule with `role`, and an MCP token for them. */
async function member(local: string, role: "admin" | "user") {
  const email = `${local}-${crypto.randomUUID().slice(0, 8)}@mcp-access.test`;
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await access.add({ pattern: email, role }, SETUP);
  const token = await mintMcpToken({ userId: seeded.userId, accountIds: [seeded.account.id] });
  return { email, userId: seeded.userId, token: token.accessToken, clientId: token.clientId };
}

beforeAll(async () => {
  // A standing admin, so test removals never touch the last admin.
  await access.add({ pattern: "standing-admin@mcp-access.test", role: "admin" }, SETUP);
});

afterEach(() => {
  vi.useRealTimers();
  forgetAccessCache();
});

describe("every MCP request rechecks the user's rule", () => {
  it("refuses a user no rule allows", async () => {
    const email = `nobody-${crypto.randomUUID().slice(0, 8)}@outside-mcp.test`;
    const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
    const token = await mintMcpToken({ userId: seeded.userId, accountIds: [seeded.account.id] });
    const r = await rpc("tools/list", {}, token.accessToken);
    expect(r.status).toBe(401);
    expect(r.body).toContain("invalid_token");
  });

  it("rejects a live token within the cache window after another isolate removes the rule", async () => {
    const m = await member("window", "user");
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start);
    expect((await rpc("tools/list", {}, m.token)).status).toBe(200);
    // Removed elsewhere: this isolate's cache is not told.
    await env.DB.prepare("DELETE FROM access_rules WHERE pattern = ?").bind(m.email).run();
    vi.setSystemTime(start + ACCESS_CACHE_MS - 1_000);
    expect((await rpc("tools/list", {}, m.token)).status).toBe(200);
    vi.setSystemTime(start + ACCESS_CACHE_MS + 1);
    const r = await rpc("tools/list", {}, m.token);
    expect(r.status).toBe(401);
    expect(r.body).toContain("invalid_token");
  });

  it("rejects the token at once, and revokes the user's apps, when the rule is removed through the product", async () => {
    const m = await member("revoked", "user");
    expect((await rpc("tools/list", {}, m.token)).status).toBe(200);
    const result = await removeRuleAndRevoke(envWithProvider(), m.email, SETUP);
    expect(result).toMatchObject({ usersShutOut: 1, appsEnded: 1, appsFailed: 0 });
    expect((await rpc("tools/list", {}, m.token)).status).toBe(401);
    expect(await openStore(env).approvals.list(m.userId)).toEqual([]);
    expect(await openStore(env).grants.list(m.userId, m.clientId)).toEqual([]);
    expect((await getOAuthApi(providerConfig, env).listUserGrants(m.userId)).items).toEqual([]);
    // Allowing the user again restores nothing: the old token stays dead.
    await access.add({ pattern: m.email, role: "user" }, SETUP);
    forgetAccessCache();
    expect((await rpc("tools/list", {}, m.token)).status).toBe(401);
  });

  it("keeps the token dead after a removal whose grant listing fails, even when the user is added again", async () => {
    const m = await member("listfail", "user");
    expect((await rpc("tools/list", {}, m.token)).status).toBe(200);
    const helpers = getOAuthApi(providerConfig, env);
    const failingListing = new Proxy(helpers, {
      get(target, key) {
        if (key === "listUserGrants") return () => Promise.reject(new Error("KV list unavailable"));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await removeRuleAndRevoke({ ...env, OAUTH_PROVIDER: failingListing } as Env, m.email, SETUP);
    expect(result).toMatchObject({ usersShutOut: 1, appsEnded: 1, appsFailed: 1 });
    expect(await openStore(env).approvals.list(m.userId)).toEqual([]);
    expect(await openStore(env).grants.list(m.userId, m.clientId)).toEqual([]);
    await access.add({ pattern: m.email, role: "user" }, SETUP);
    forgetAccessCache();
    expect((await rpc("tools/list", {}, m.token)).status).toBe(401);
  });

  it("keeps the token dead after a removal whose grant revokes all fail", async () => {
    const m = await member("revokefail", "user");
    const helpers = getOAuthApi(providerConfig, env);
    const failingRevoke = new Proxy(helpers, {
      get(target, key) {
        if (key === "revokeGrant") return () => Promise.reject(new Error("KV write unavailable"));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await removeRuleAndRevoke({ ...env, OAUTH_PROVIDER: failingRevoke } as Env, m.email, SETUP);
    expect(result.appsFailed).toBeGreaterThan(0);
    await access.add({ pattern: m.email, role: "user" }, SETUP);
    forgetAccessCache();
    expect((await rpc("tools/list", {}, m.token)).status).toBe(401);
  });

  it("cuts a person off when the two rules covering them are removed at the same time, so a re-add revives nothing", async () => {
    const domain = `ov-${crypto.randomUUID().slice(0, 8)}.test`;
    const email = `u@${domain}`;
    const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
    await access.add({ pattern: email, role: "user" }, SETUP);
    await access.add({ pattern: `@${domain}`, role: "user" }, SETUP);
    const token = await mintMcpToken({ userId: seeded.userId, accountIds: [seeded.account.id] });
    expect((await rpc("tools/list", {}, token.accessToken)).status).toBe(200);

    const results = await Promise.all([
      removeRuleAndRevoke(envWithProvider(), email, SETUP),
      removeRuleAndRevoke(envWithProvider(), `@${domain}`, SETUP),
    ]);
    expect(results.map((r) => r.removed?.pattern).sort()).toEqual([`@${domain}`, email].sort());
    // Whichever removal ran second saw both rules gone: the person is reported shut out, and their rows are gone.
    expect(results.some((r) => r.usersShutOut === 1 && r.appsEnded === 1)).toBe(true);
    expect(await openStore(env).approvals.list(seeded.userId)).toEqual([]);
    expect(await openStore(env).grants.list(seeded.userId, token.clientId)).toEqual([]);

    await access.add({ pattern: email, role: "user" }, SETUP);
    forgetAccessCache();
    expect((await rpc("tools/list", {}, token.accessToken)).status).toBe(401);
  });

  it("answers 503, never serving the request, when the access lookup fails", async () => {
    const m = await member("dbfail", "user");
    forgetAccessCache();
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (/FROM users|access_rules/.test(sql)) throw new Error("D1 unavailable");
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const verified = { token: m.token, userId: m.userId, clientId: m.clientId };
    const ctx = { auth: verified, props: { userId: m.userId, clientId: m.clientId }, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await mcpApiHandler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      { ...env, DB: failing },
      ctx,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("tools");
  });
});

describe("sdk.access", () => {
  it("is refused to a non-admin with a structured error, for reads and writes alike", async () => {
    const m = await member("plain", "user");
    for (const [code, apply] of [
      ["async () => sdk.access.list()", false],
      ['async () => sdk.access.add({ pattern: "@sneaky.test", role: "admin" })', true],
      ['async () => sdk.access.remove({ pattern: "standing-admin@mcp-access.test" })', true],
    ] as const) {
      const r = await execute(m.token, code, apply);
      expect(r.isError).toBe(true);
      expect((r.value.error as { code: string }).code).toBe("GWS_ACCESS_ADMIN_REQUIRED");
    }
    expect(await access.get("@sneaky.test")).toBeNull();
    expect(await access.get("standing-admin@mcp-access.test")).not.toBeNull();
  });

  it("refuses a non-admin also when the input waits on an unexecuted write, never planning a step", async () => {
    const m = await member("pending", "user");
    // A dry-run Google write returns a pending value; an input built from it waits on that unexecuted write.
    const code = 'async () => { const f = await sdk.drive.files.create({ requestBody: { name: "x" } }); return sdk.access.remove({ pattern: `${f}@x.test` }); }';
    const r = await execute(m.token, code);
    expect(r.isError).toBe(true);
    expect((r.value.error as { code: string }).code).toBe("GWS_ACCESS_ADMIN_REQUIRED");
    expect((r.value.plan as Array<{ fn: string }>).some((s) => s.fn === "access.remove")).toBe(false);
  });

  it("marks a removal whose input waits on an unexecuted write as destructive in the plan", async () => {
    const m = await member("pending-admin", "admin");
    const code = 'async () => { const f = await sdk.drive.files.create({ requestBody: { name: "x" } }); return sdk.access.remove({ pattern: `${f}@x.test` }); }';
    const r = await execute(m.token, code);
    expect(r.isError).toBe(false);
    expect(r.value.destructive).toBe(true);
    expect(r.value.plan).toEqual([
      expect.objectContaining({ fn: "drive.files.create", destructive: false }),
      expect.objectContaining({ fn: "access.remove", destructive: true, incomplete: true }),
    ]);
  });

  it("lists the rules to an admin", async () => {
    const m = await member("lister", "admin");
    const r = await execute(m.token, "async () => sdk.access.list()");
    expect(r.isError).toBe(false);
    const rules = (r.value.result as { rules: Array<{ pattern: string; role: string; kind: string; addedAt: string }> }).rules;
    expect(rules).toEqual(expect.arrayContaining([expect.objectContaining({ pattern: m.email, role: "admin", kind: "email" })]));
    expect(JSON.stringify(rules)).not.toContain("createdBy");
  });

  it("plans an add in dry-run without changing anything, then applies it with one audit row", async () => {
    const m = await member("adder", "admin");
    const dry = await execute(m.token, 'async () => sdk.access.add({ pattern: "@Added-By-Sdk.test", role: "user" })');
    expect(dry.isError).toBe(false);
    expect(dry.value.result).toEqual({ applied: false, step: "s1" });
    expect(dry.value.plan).toEqual([expect.objectContaining({ fn: "access.add", effect: "write", destructive: false })]);
    expect(await access.get("@added-by-sdk.test")).toBeNull();

    const applied = await execute(m.token, 'async () => sdk.access.add({ pattern: "@Added-By-Sdk.test", role: "user" })', true);
    expect(applied.value.result).toMatchObject({ applied: true, outcome: "added", rule: { pattern: "@added-by-sdk.test", role: "user", kind: "domain" } });
    const audit = await env.DB.prepare("SELECT actor, via, action, pattern_kind FROM access_audit WHERE pattern = '@added-by-sdk.test'").all();
    expect(audit.results).toEqual([{ actor: m.userId, via: "sdk", action: "add", pattern_kind: "domain" }]);
  });

  it("marks a removal destructive in dry-run, and under apply removes the rule and ends the shut-out user's apps", async () => {
    const admin = await member("remover", "admin");
    const target = await member("target", "user");
    const code = `async () => sdk.access.remove({ pattern: ${JSON.stringify(target.email)} })`;
    const dry = await execute(admin.token, code);
    expect(dry.value.destructive).toBe(true);
    expect(await access.get(target.email)).not.toBeNull();

    const applied = await execute(admin.token, code, true);
    expect(applied.value.result).toEqual({ applied: true, removed: true, usersShutOut: 1, appsEnded: 1, appsFailed: 0 });
    expect((await rpc("tools/list", {}, target.token)).status).toBe(401);
    expect(await openStore(env).approvals.list(target.userId)).toEqual([]);
  });

  it("refuses to remove or demote the last admin", async () => {
    await env.DB.prepare("DELETE FROM access_rules WHERE role = 'admin'").run();
    const m = await member("last", "admin");
    forgetAccessCache();
    for (const code of [
      `async () => sdk.access.remove({ pattern: ${JSON.stringify(m.email)} })`,
      `async () => sdk.access.add({ pattern: ${JSON.stringify(m.email)}, role: "user" })`,
    ]) {
      const r = await execute(m.token, code, true);
      expect(r.isError).toBe(true);
      expect(r.value.error).toMatchObject({ code: "GWS_INVALID_INPUT", details: { reason: "last_admin" } });
    }
    expect(await access.get(m.email)).toMatchObject({ role: "admin" });
    await access.add({ pattern: "standing-admin@mcp-access.test", role: "admin" }, SETUP);
  });
});

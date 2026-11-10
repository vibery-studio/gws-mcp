import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config";
import { HOST_CONFIG_KEYS, type AccountsCapability, type AuthProps, type CallCtx, type FnDef } from "../../src/contracts";
import { peekGrantRequest, revokeAndWipe, takeConnectRequest, takeGrantRequest } from "../../src/core/accounts-capability";
import capabilitySource from "../../src/core/accounts-capability.ts?raw";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { buildRegistry, getRegistry } from "../../src/core/registry";
import type { WireError } from "../../src/errors";
import { googleOAuth } from "../../src/google/oauth";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { fakeTransport, seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";

const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const LIST = "gmail.users.messages.list";
const store = openStore(env);
const baseConfig = loadConfig(env);

type Op = (accounts: AccountsCapability, input: Record<string, unknown>) => Promise<unknown>;

/** An `accounts.*` host fn that runs `op` against the capability it is handed. */
function accountsFn(op: Op, effect: FnDef["effect"] = "write"): FnDef {
  return {
    name: "accounts.probe",
    service: "accounts",
    effect,
    kind: "host",
    description: "",
    signature: "",
    tsDecl: "",
    example: "",
    tags: [],
    scopes: [],
    input: z.looseObject({}),
    output: z.unknown(),
    async run(input, ctx: CallCtx) {
      if (!ctx.accounts) throw new Error("no accounts capability");
      return op(ctx.accounts, input as Record<string, unknown>);
    },
  };
}

/** One user with A (default, alias "work") and B; the client is allowlisted for A only. */
async function setup() {
  const a = await seedUserWithAccount(env, { email: uniqueEmail("cap-a"), scopes: [GMAIL_RO], alias: "work", isDefault: true });
  const b = await seedUserWithAccount(env, { email: uniqueEmail("cap-b"), scopes: [GMAIL_RO], userId: a.userId });
  const client: AuthProps = { userId: a.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(a.userId, client.clientId, a.account.id);
  return { a, b, client };
}

function run(auth: AuthProps, apply: boolean, op: Op, input: Record<string, unknown> = {}, effect: FnDef["effect"] = "write") {
  const executeId = `x-${crypto.randomUUID()}`;
  const s = createCallSession({ ports: workersPorts(env), auth, apply, executeId, config: baseConfig, registry: buildRegistry([...getRegistry().values(), accountsFn(op, effect)]) });
  return { s, executeId, result: s.dispatch("accounts.probe", input) };
}

function errorOf(r: DispatchResult): WireError {
  if (!("__gwsError" in r)) throw new Error(`expected an error result, got ${JSON.stringify(r)}`);
  return r.__gwsError;
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value;
}

/** Everything a capability could change: accounts, every client's allowlist, pending link records. */
async function snapshot(userId: string) {
  const accounts = await store.accounts.listForUser(userId);
  const { results: grants } = await env.DB.prepare("SELECT client_id, account_id FROM client_grants WHERE user_id = ? ORDER BY client_id, account_id")
    .bind(userId)
    .all();
  const links = (await env.CACHE_KV.list({ prefix: "req:" })).keys.length;
  return { accounts, grants, links };
}

const WRITES: Array<[string, (ref: string) => Op]> = [
  ["setAlias", (ref) => (c) => c.setAlias(ref, "renamed")],
  ["setDefault", (ref) => (c) => c.setDefault(ref)],
  ["disconnect", (ref) => (c) => c.disconnect(ref)],
  ["ungrant", (ref) => (c) => c.ungrant(ref)],
];

describe("accounts capability: who gets it", () => {
  it("is handed only to accounts.* fns, never to helpers", async () => {
    let helperCtx: CallCtx | undefined;
    const helper: FnDef = {
      ...accountsFn(async () => ({})),
      name: "helpers.peek",
      service: "helpers",
      async run(_i, ctx) {
        helperCtx = ctx;
        return {};
      },
    };
    const { client } = await setup();
    const s = createCallSession({ ports: workersPorts(env), auth: client, apply: true, executeId: "x", config: baseConfig, registry: buildRegistry([helper]) });
    valueOf(await s.dispatch("helpers.peek", {}));
    expect(helperCtx && "accounts" in helperCtx).toBe(false);
  });

  it("hands host fns only non-secret config values and capabilities, never a binding", async () => {
    let seen: CallCtx | undefined;
    const { client } = await setup();
    const capture: FnDef = { ...accountsFn(async () => ({}), "read"), run: async (_i, ctx) => ((seen = ctx), {}) };
    const s = createCallSession({ ports: workersPorts(env), auth: client, apply: false, executeId: "x", config: baseConfig, registry: buildRegistry([capture]) });
    valueOf(await s.dispatch("accounts.probe", {}));
    if (!seen) throw new Error("host fn did not run");
    expect(Object.keys(seen).sort()).toEqual(["accounts", "apply", "auth", "call", "config", "executeId", "planStep", "resolveAllowed"]);
    expect(Object.keys(seen.config).sort()).toEqual([...HOST_CONFIG_KEYS].sort());
    const bindings = [env.DB, env.CACHE_KV, env.OAUTH_KV, env.FAKE_GOOGLE, env.LOADER, env.TOKEN_ENC_KEY, env.GOOGLE_CLIENT_SECRET];
    const reachable = new Set<unknown>();
    const stack: unknown[] = [seen];
    while (stack.length > 0) {
      const v = stack.pop();
      if ((typeof v === "object" || typeof v === "function") && v !== null && !reachable.has(v)) {
        reachable.add(v);
        for (const k of Object.getOwnPropertyNames(v)) stack.push((v as Record<string, unknown>)[k]);
      } else reachable.add(v);
    }
    for (const b of bindings) expect(reachable.has(b)).toBe(false);
  });

  it("has no path that adds to an allowlist", () => {
    expect(capabilitySource).not.toMatch(/grants\.(add|replace)\b/);
  });
});

describe("accounts capability: no confused deputy", () => {
  it.each(WRITES)("refuses %s on an account outside the client's allowlist, under apply, changing nothing", async (_name, write) => {
    const { a, b, client } = await setup();
    const before = await snapshot(a.userId);
    const err = errorOf(await run(client, true, write(b.account.email)).result);
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
    expect(err.details).toEqual({ account: b.account.email });
    expect(await snapshot(a.userId)).toEqual(before);
  });

  it.each(WRITES)("refuses %s on another user's account with the same error as an unknown one", async (_name, write) => {
    const { client } = await setup();
    const other = await seedUserWithAccount(env, { email: uniqueEmail("cap-other"), scopes: [GMAIL_RO], alias: "mine" });
    const before = await snapshot(other.userId);
    const err = errorOf(await run(client, true, write(other.account.email)).result);
    const unknown = errorOf(await run(client, true, write(other.account.email.replace("cap-other", "cap-nobody"))).result);
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
    expect({ ...err, details: undefined }).toEqual({ ...unknown, details: undefined });
    const alias = errorOf(await run(client, true, write("mine")).result);
    const noAlias = errorOf(await run(client, true, write("nobody")).result);
    expect([alias.details, noAlias.details]).toEqual([{ account: "mine" }, { account: "nobody" }]);
    expect({ ...alias, details: undefined }).toEqual({ ...noAlias, details: undefined });
    expect({ ...alias, details: undefined }).toEqual({ ...err, details: undefined });
    expect(await snapshot(other.userId)).toEqual(before);
  });

  it("answers an alias collision with a hidden account without echoing any account's email", async () => {
    const { a, b, client } = await setup();
    await store.accounts.setAlias(b.userId, b.account.id, "hidden");
    const err = errorOf(await run(client, true, (c) => c.setAlias("work", "hidden")).result);
    expect(err).toEqual({ code: "GWS_INVALID_INPUT", fn: "accounts.probe", message: "alias is already used by another of your accounts", details: { fields: ["alias"] } });
    expect(JSON.stringify(err)).not.toContain("@");
    expect((await store.accounts.get(a.userId, a.account.id))?.alias).toBe("work");
  });

  it("cannot widen its own allowlist: a grant request under apply only stores a link and adds no grant", async () => {
    const { a, client } = await setup();
    const out = valueOf(await run(client, true, (c) => c.requestGrant()).result) as { applied: true; value: { url: string; expiresAt: number } };
    expect(out.applied).toBe(true);
    expect(out.value.url).toMatch(/^http:\/\/localhost\/connections\/confirm\?t=[A-Za-z0-9_-]{43}$/);
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id]);
  });

  it("does not set as default an allowlisted account when the current default is outside the allowlist", async () => {
    const { a, b, client } = await setup();
    await store.accounts.setDefault(a.userId, b.account.id);
    const before = await snapshot(a.userId);
    const err = errorOf(await run(client, true, (c) => c.setDefault(a.account.email)).result);
    expect(err).toMatchObject({ code: "GWS_ACCOUNT_DENIED", details: { account: "default" } });
    expect(await snapshot(a.userId)).toEqual(before);
  });

  it("lists only the client's allowlisted accounts, with a count of the others and no ids", async () => {
    const { a, client } = await setup();
    const listed = valueOf(await run(client, false, (c) => c.list(), {}, "read").result) as { accounts: object[]; hiddenCount: number };
    expect(listed).toEqual({
      accounts: [{ email: a.account.email, alias: "work", isDefault: true, scopes: a.account.scopes, status: "active" }],
      hiddenCount: 1,
    });
  });

  it("gets an allowlisted account by alias or default and denies others", async () => {
    const { a, b, client } = await setup();
    expect(valueOf(await run(client, false, (c) => c.get("work"), {}, "read").result)).toMatchObject({ email: a.account.email });
    expect(valueOf(await run(client, false, (c) => c.get(), {}, "read").result)).toMatchObject({ email: a.account.email });
    expect(errorOf(await run(client, false, (c) => c.get(b.account.email), {}, "read").result).code).toBe("GWS_ACCOUNT_DENIED");
  });
});

describe("accounts capability: a disconnected account", () => {
  /** A (allowlisted, default, alias "work") and B (not allowlisted), both disconnected. */
  async function disconnectedSetup() {
    const s = await setup();
    await store.accounts.wipeToken(s.a.userId, s.a.account.id);
    await store.accounts.wipeToken(s.b.userId, s.b.account.id);
    return s;
  }

  it("lists and gets an allowlisted disconnected account as needing reconnect, and still hides the others", async () => {
    const { a, client } = await disconnectedSetup();
    const listed = valueOf(await run(client, false, (c) => c.list(), {}, "read").result);
    expect(listed).toEqual({ accounts: [{ email: a.account.email, alias: "work", isDefault: true, scopes: [], status: "reconnect" }], hiddenCount: 1 });
    expect(valueOf(await run(client, false, (c) => c.get("work"), {}, "read").result)).toMatchObject({ email: a.account.email, status: "reconnect" });
  });

  it.each(WRITES.filter(([name]) => name !== "ungrant"))(
    "refuses %s on it with the reconnect error to an allowlisted client, changing nothing",
    async (_name, write) => {
      const { a, client } = await disconnectedSetup();
      const before = await snapshot(a.userId);
      const err = errorOf(await run(client, true, write(a.account.email)).result);
      expect(err.code).toBe("GWS_RECONNECT_REQUIRED");
      expect(err.account).toBe(a.account.email);
      expect(err.message).toContain("allow it for this client again");
      expect(await snapshot(a.userId)).toEqual(before);
    },
  );

  it.each(WRITES)("refuses %s on it with the uniform denial to a client that may not use it", async (_name, write) => {
    const { b, client } = await disconnectedSetup();
    const before = await snapshot(b.userId);
    const err = errorOf(await run(client, true, write(b.account.email)).result);
    const unknown = errorOf(await run(client, true, write(b.account.email.replace("cap-b", "cap-nobody"))).result);
    expect(err).toEqual({ ...unknown, details: { account: b.account.email } });
    expect(await snapshot(b.userId)).toEqual(before);
  });

  it("lets an allowlisted client drop its own kept row", async () => {
    const { a, client } = await disconnectedSetup();
    expect(valueOf(await run(client, true, (c) => c.ungrant("work")).result)).toEqual({ applied: true, value: { email: a.account.email } });
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([]);
  });
});

describe("accounts capability: dry-run", () => {
  const ops: Array<[string, Op, boolean]> = [
    ["setAlias", (c) => c.setAlias("work", "renamed"), false],
    ["setDefault", (c) => c.setDefault("work"), false],
    ["disconnect", (c) => c.disconnect("work"), true],
    ["ungrant", (c) => c.ungrant("work"), false],
    ["requestGrant", (c) => c.requestGrant("hint@fake.test"), false],
  ];

  it.each(ops)("plans %s and changes nothing", async (_name, op, destructive) => {
    const { a, client } = await setup();
    const before = await snapshot(a.userId);
    const { s, result } = run(client, false, op);
    expect(valueOf(await result)).toEqual({ applied: false, step: "s1" });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ effect: "write", destructive });
    expect(s.calls.map((c) => c.status)).toEqual(["planned"]);
    expect(await snapshot(a.userId)).toEqual(before);
    const refresh = await googleOAuth(env, fakeTransport).refresh(a.refreshToken);
    expect(refresh.accessToken.length).toBeGreaterThan(0);
  });
});

describe("accounts capability: apply", () => {
  it("sets an alias that later calls resolve", async () => {
    const { a, client } = await setup();
    valueOf(await run(client, true, (c) => c.setAlias("work", "office")).result);
    const s = createCallSession({ ports: workersPorts(env), auth: client, apply: false, executeId: "x", config: baseConfig });
    valueOf(await s.dispatch(LIST, { userId: "me", account: "office" }));
    expect((await store.accounts.get(a.userId, a.account.id))?.alias).toBe("office");
  });

  it("sets the default when both the new and the current default are allowlisted", async () => {
    const { a, b, client } = await setup();
    await store.grants.add(a.userId, client.clientId, b.account.id);
    const out = valueOf(await run(client, true, (c) => c.setDefault(b.account.email)).result);
    expect(out).toMatchObject({ applied: true, value: { email: b.account.email, isDefault: true } });
    expect((await store.accounts.get(a.userId, b.account.id))?.isDefault).toBe(true);
  });

  it("ungrants one account for the calling client only", async () => {
    const { a, b, client } = await setup();
    await store.grants.add(a.userId, client.clientId, b.account.id);
    const other: AuthProps = { userId: a.userId, clientId: `client-o-${crypto.randomUUID()}` };
    await store.grants.add(a.userId, other.clientId, a.account.id);
    valueOf(await run(client, true, (c) => c.ungrant("work")).result);
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([b.account.id]);
    expect(await store.grants.list(a.userId, other.clientId)).toEqual([a.account.id]);
    expect((await store.accounts.get(a.userId, a.account.id))?.status).toBe("active");
  });

  it("disconnects: revokes at Google, wipes the token, keeps the allowlist rows, audits an applied destructive write", async () => {
    const { a, client } = await setup();
    const { s, executeId, result } = run(client, true, (c) => c.disconnect("work"));
    expect(valueOf(await result)).toEqual({ applied: true, value: { email: a.account.email } });
    expect(s.appliedDestructive).toBe(true);
    await s.close();
    await expect(googleOAuth(env, fakeTransport).refresh(a.refreshToken)).rejects.toMatchObject({ code: "GWS_RECONNECT_REQUIRED" });
    const after = await store.accounts.get(a.userId, a.account.id);
    expect(after).toMatchObject({ status: "disconnected", hasRefreshToken: false, scopes: [] });
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id]);
    const { results } = await env.DB.prepare("SELECT fn, status, applied, account_id FROM audit_log WHERE execute_id = ?").bind(executeId).all();
    expect(results).toEqual([{ fn: "accounts.probe", status: "ok", applied: 1, account_id: a.account.id }]);
  });

  it("disconnects an account in reconnect state: revokes its stored token at Google before wiping it", async () => {
    const { a, client } = await setup();
    await store.accounts.markStatus(a.userId, a.account.id, "reconnect");
    const { s, result } = run(client, true, (c) => c.disconnect("work"));
    expect(valueOf(await result)).toEqual({ applied: true, value: { email: a.account.email } });
    await s.close();
    await expect(googleOAuth(env, fakeTransport).refresh(a.refreshToken)).rejects.toMatchObject({ code: "GWS_RECONNECT_REQUIRED" });
    expect(await store.accounts.get(a.userId, a.account.id)).toMatchObject({ status: "disconnected", hasRefreshToken: false });
  });

  it("reads a token regardless of status only in disconnect", () => {
    // Every reference across src/** (exact per-file map, type-checked calls, no dynamic access) is checked in
    // test/node/refresh-token-read.test.ts; a text scan here could be bypassed with a property reference.
    expect(capabilitySource.match(/getRefreshTokenForRevoke\(/g)).toHaveLength(1);
  });

  it("issues a single-use grant link bound to the calling user and client", async () => {
    const { a, client } = await setup();
    const out = valueOf(await run(client, true, (c) => c.requestGrant("work")).result) as { value: { url: string } };
    const token = new URL(out.value.url).searchParams.get("t") ?? "";
    expect(await takeGrantRequest(env.CACHE_KV, token, `u_${crypto.randomUUID()}`)).toBeNull();
    const out2 = valueOf(await run(client, true, (c) => c.requestGrant()).result) as { value: { url: string } };
    const token2 = new URL(out2.value.url).searchParams.get("t") ?? "";
    expect(await takeGrantRequest(env.CACHE_KV, token2, a.userId)).toMatchObject({ userId: a.userId, clientId: client.clientId });
    expect(await takeGrantRequest(env.CACHE_KV, token2, a.userId)).toBeNull();
    expect(await takeGrantRequest(env.CACHE_KV, token, a.userId)).toBeNull();
  });

  it("issues a single-use connect link bound to the calling user, as a read", async () => {
    const { a, client } = await setup();
    const { s, result } = run(client, false, (c) => c.connectUrl(["sheets"]), {}, "read");
    const link = valueOf(await result) as { url: string };
    expect(s.plan).toEqual([]);
    expect(link.url).toMatch(/^http:\/\/localhost\/connect\/start\?t=[A-Za-z0-9_-]{43}$/);
    const token = new URL(link.url).searchParams.get("t") ?? "";
    expect(await takeConnectRequest(env.CACHE_KV, token, a.userId)).toMatchObject({ userId: a.userId, clientId: client.clientId, services: ["sheets"] });
    expect(await takeConnectRequest(env.CACHE_KV, token, a.userId)).toBeNull();
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id]);
  });

  it("lets the confirmation page read a grant link without consuming it, only for its user and before it expires", async () => {
    const { a, client } = await setup();
    const out = valueOf(await run(client, true, (c) => c.requestGrant("work")).result) as { value: { url: string; expiresAt: number } };
    const token = new URL(out.value.url).searchParams.get("t") ?? "";
    expect(await peekGrantRequest(env.CACHE_KV, token, `u_${crypto.randomUUID()}`)).toBeNull();
    expect(await peekGrantRequest(env.CACHE_KV, token, a.userId, out.value.expiresAt)).toBeNull();
    expect(await peekGrantRequest(env.CACHE_KV, "x".repeat(43), a.userId)).toBeNull();
    const expected = { kind: "grant", userId: a.userId, clientId: client.clientId, hint: "work" };
    expect(await peekGrantRequest(env.CACHE_KV, token, a.userId)).toMatchObject(expected);
    expect(await peekGrantRequest(env.CACHE_KV, token, a.userId)).toMatchObject(expected);
    expect(await takeGrantRequest(env.CACHE_KV, token, a.userId)).toMatchObject(expected);
    expect(await peekGrantRequest(env.CACHE_KV, token, a.userId)).toBeNull();
  });

  it("revokes and wipes an account outside a client session too, for the signed-in human", async () => {
    const { a, b, client } = await setup();
    await store.grants.add(a.userId, client.clientId, b.account.id);
    const deps = { store, oauth: googleOAuth(env, fakeTransport), invalidateToken: async () => undefined };
    await revokeAndWipe(deps, b.userId, b.account.id);
    await expect(googleOAuth(env, fakeTransport).refresh(b.refreshToken)).rejects.toMatchObject({ code: "GWS_RECONNECT_REQUIRED" });
    expect(await store.accounts.get(b.userId, b.account.id)).toMatchObject({ status: "disconnected", hasRefreshToken: false, scopes: [] });
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id, b.account.id].sort());
  });

  it("rejects malformed arguments with GWS_INVALID_INPUT", async () => {
    const { client } = await setup();
    const bad = (c: AccountsCapability) => c.connectUrl(["nope" as "sheets"]);
    expect(errorOf(await run(client, false, bad, {}, "read").result).code).toBe("GWS_INVALID_INPUT");
    expect(errorOf(await run(client, true, (c) => c.requestGrant("two words")).result).code).toBe("GWS_INVALID_INPUT");
    expect(errorOf(await run(client, true, (c) => c.setDefault(42 as unknown as string)).result).code).toBe("GWS_INVALID_INPUT");
  });
});

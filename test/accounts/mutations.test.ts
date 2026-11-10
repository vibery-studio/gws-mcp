import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { peekGrantRequest } from "../../src/core/accounts-capability";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import type { WireError } from "../../src/errors";
import { googleOAuth } from "../../src/google/oauth";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { loadReadModel } from "../../src/web/read-model";
import { fakeTransport, seedUserWithAccount, type SeededAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";
import { mintMcpToken } from "../helpers/mcp-token";
import { BASE, Browser, loginCallback, pickAtFake } from "../auth/browser";

const G = "https://www.googleapis.com/auth/";
const GMAIL = [`${G}gmail.readonly`, `${G}gmail.send`];
const config = loadConfig(env);
const store = openStore(env);

function session(auth: AuthProps, apply: boolean) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { executeId, s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config }) };
}

async function call(auth: AuthProps, fn: string, input: unknown, apply: boolean) {
  const { s, executeId } = session(auth, apply);
  const result = await s.dispatch(fn, input);
  await s.close();
  return { s, executeId, result };
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value, got ${JSON.stringify(r)}`);
  return r.value;
}

function errorOf(r: DispatchResult): WireError {
  if (!("__gwsError" in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return r.__gwsError;
}

/**
 * A user with A (default, alias "work") and B, both with gmail. `client` is an approved MCP client allowed A
 * and B; `other` is a second client allowed B only.
 */
async function setup(prefix: string) {
  const a = await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-a`), scopes: GMAIL, alias: "work", isDefault: true });
  const b = await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-b`), scopes: GMAIL, userId: a.userId });
  const minted = await mintMcpToken({ userId: a.userId, accountIds: [a.account.id, b.account.id] });
  const client: AuthProps = { userId: a.userId, clientId: minted.clientId };
  const other: AuthProps = { userId: a.userId, clientId: (await mintMcpToken({ userId: a.userId, accountIds: [b.account.id] })).clientId };
  return { a, b, client, other };
}

const LIST = "gmail.users.messages.list";

/** `setup` plus `outsider`, a third client allowed A only. */
async function setupWithOutsider(prefix: string) {
  const s = await setup(prefix);
  const outsider: AuthProps = { userId: s.a.userId, clientId: (await mintMcpToken({ userId: s.a.userId, accountIds: [s.a.account.id] })).clientId };
  return { ...s, outsider };
}

/** The error a client gets for a Gmail call on `ref`, with its own ref echo removed for comparison. */
async function callError(auth: AuthProps, ref: string) {
  const err = errorOf((await call(auth, LIST, { userId: "me", account: ref }, false)).result);
  return { ...err, details: undefined };
}

function postForm(browser: Browser, path: string, fields: Array<[string, string]>): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(fields).toString(),
  });
}

async function csrfOf(browser: Browser): Promise<string> {
  const csrf = /name="csrf" value="([^"]+)"/.exec(await (await browser.fetch("/accounts")).text())?.[1];
  if (!csrf) throw new Error("accounts page has no csrf field");
  return csrf;
}

/** The human signs in as A and reconnects B (gmail) from /connections through Google consent; returns the browser. */
async function reconnect(a: SeededAccount, b: SeededAccount): Promise<Browser> {
  const browser = new Browser();
  await loginCallback(browser, a.account.email);
  const start = await postForm(browser, "/connections/connect", [["csrf", await csrfOf(browser)], ["service", "gmail"], ["account", b.account.id]]);
  const callback = await browser.fetch(await pickAtFake(start.headers.get("location") ?? "", b.account.email));
  expect(callback.status).toBe(302);
  return browser;
}

/** Gmail API requests the fake received for `email` (token refreshes excluded). */
async function gmailRequests(email: string): Promise<number> {
  return (await fake.requests(email)).filter((r) => r.path.startsWith("/gmail.googleapis.com/")).length;
}

async function state(userId: string) {
  const { results: grants } = await env.DB.prepare("SELECT client_id, account_id FROM client_grants WHERE user_id = ? ORDER BY client_id, account_id")
    .bind(userId)
    .all();
  return { accounts: await store.accounts.listForUser(userId), grants };
}

describe("accounts.disconnect", () => {
  it("only plans in dry-run: a destructive step, nothing changed, the token still works", async () => {
    const { b, client } = await setup("mut-dry");
    const before = await state(b.userId);
    const { s, result } = await call(client, "accounts.disconnect", { account: b.account.email }, false);
    const step = (valueOf(result) as { step: string }).step;
    expect(valueOf(result)).toEqual({ applied: false, step });
    expect(s.plan).toEqual([{ step, fn: "accounts.disconnect", account: b.account.email, effect: "write", destructive: true }]);
    expect(s.destructive).toBe(true);
    expect(await state(b.userId)).toEqual(before);
    await expect(googleOAuth(env, fakeTransport).refresh(b.refreshToken)).resolves.toBeDefined();
  });

  it("revokes at Google under apply, wipes the account, keeps its allowlist rows, and tells only allowlisted clients to reconnect", async () => {
    const { a, b, client, other, outsider } = await setupWithOutsider("mut-apply");
    await fake.seed({ accounts: [{ email: b.account.email, sub: b.sub, preset: "default" }] });
    expect(valueOf((await call(client, LIST, { userId: "me", account: b.account.email }, false)).result)).toBeDefined();

    const { executeId, result } = await call(client, "accounts.disconnect", { account: b.account.email }, true);
    expect(valueOf(result)).toEqual({ applied: true, email: b.account.email });
    await expect(googleOAuth(env, fakeTransport).refresh(b.refreshToken)).rejects.toMatchObject({ code: "GWS_RECONNECT_REQUIRED" });
    expect(await store.accounts.get(b.userId, b.account.id)).toMatchObject({ status: "disconnected", hasRefreshToken: false, scopes: [] });
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id, b.account.id].sort());
    expect(await store.grants.list(a.userId, other.clientId)).toEqual([b.account.id]);
    const { results } = await env.DB.prepare("SELECT fn, applied, status FROM audit_log WHERE execute_id = ?").bind(executeId).all();
    expect(results).toEqual([{ fn: "accounts.disconnect", applied: 1, status: "ok" }]);

    const gmailCalls = await gmailRequests(b.account.email);
    for (const allowed of [client, other]) {
      const next = errorOf((await call(allowed, LIST, { userId: "me", account: b.account.email }, false)).result);
      expect(next).toMatchObject({ code: "GWS_RECONNECT_REQUIRED", account: b.account.email });
      expect(next.message).toContain("allow it for this client again");
    }
    // A client that was never allowed the account learns nothing: the same denial as for an unknown account.
    expect(await callError(outsider, b.account.email)).toEqual(await callError(outsider, uniqueEmail("mut-apply-nobody")));
    expect((await callError(outsider, b.account.email)).code).toBe("GWS_ACCOUNT_DENIED");
    expect(await gmailRequests(b.account.email)).toBe(gmailCalls);
  });
});

describe("reconnecting a disconnected account", () => {
  it("restores no client's access: an allowed client gets the uniform denial until the human allows the account again", async () => {
    const { a, b, client, other, outsider } = await setupWithOutsider("mut-reconnect");
    await fake.seed({ accounts: [{ email: b.account.email, sub: b.sub, preset: "default" }] });
    valueOf((await call(client, "accounts.disconnect", { account: b.account.email }, true)).result);
    // A confirmation that passed its "active" check just before the disconnect lands its grant afterwards.
    await store.grants.add(a.userId, outsider.clientId, b.account.id);

    const browser = await reconnect(a, b);
    expect(await store.accounts.get(b.userId, b.account.id)).toMatchObject({ status: "active", hasRefreshToken: true });
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id]);
    expect(await store.grants.list(a.userId, other.clientId)).toEqual([]);
    expect(await store.grants.list(a.userId, outsider.clientId)).toEqual([a.account.id]);
    const gmailCalls = await gmailRequests(b.account.email);
    for (const auth of [client, other, outsider]) {
      expect(await callError(auth, b.account.email)).toEqual(await callError(auth, uniqueEmail("mut-reconnect-nobody")));
      expect((await callError(auth, b.account.email)).code).toBe("GWS_ACCOUNT_DENIED");
    }
    expect(await gmailRequests(b.account.email)).toBe(gmailCalls);

    // Only the human's grant on /connections gives the client the account back.
    const csrf = await csrfOf(browser);
    const granted = await postForm(browser, "/connections/client-grant", [["csrf", csrf], ["client", client.clientId], ["account", b.account.id]]);
    expect(granted.status).toBe(303);
    expect(valueOf((await call(client, LIST, { userId: "me", account: b.account.email }, false)).result)).toBeDefined();
    expect((await callError(other, b.account.email)).code).toBe("GWS_ACCOUNT_DENIED");
  });

  it("restores no access when a token-less consent moved it to reconnect state before the reconnect", async () => {
    const { a, b, client, other } = await setupWithOutsider("mut-reconnect-p2");
    valueOf((await call(client, "accounts.disconnect", { account: b.account.email }, true)).result);
    // Google answers a consent without a refresh token when a grant exists and prompt=consent was not sent.
    const tokenless = await store.accounts.upsertConnected({ userId: b.userId, email: b.account.email, sub: b.sub, scopes: ["openid", "email"] });
    expect(tokenless.status).toBe("reconnect");
    expect((await callError(client, b.account.email)).code).toBe("GWS_ACCOUNT_DENIED");

    await reconnect(a, b);
    expect((await store.accounts.get(b.userId, b.account.id))?.status).toBe("active");
    for (const auth of [client, other]) expect((await callError(auth, b.account.email)).code).toBe("GWS_ACCOUNT_DENIED");
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id]);
  });
});

describe("accounts.setDefault and accounts.alias", () => {
  it("plan in dry-run and change nothing", async () => {
    const { a, b, client } = await setup("mut-settings-dry");
    const before = await state(a.userId);
    for (const [fn, input] of [
      ["accounts.setDefault", { account: b.account.email }],
      ["accounts.alias", { account: b.account.email, alias: "bee" }],
      ["accounts.ungrant", { account: b.account.email }],
    ] as const) {
      const { s, result } = await call(client, fn, input, false);
      expect(valueOf(result)).toMatchObject({ applied: false });
      expect(s.plan).toMatchObject([{ fn, account: b.account.email, effect: "write", destructive: false }]);
    }
    expect(await state(a.userId)).toEqual(before);
  });

  it("persist under apply, and a new session resolves the alias and the default", async () => {
    const { a, b, client } = await setup("mut-settings");
    await fake.seed({ accounts: [{ email: b.account.email, sub: b.sub, preset: "default" }] });
    expect(valueOf((await call(client, "accounts.alias", { account: b.account.email, alias: "Bee" }, true)).result)).toMatchObject({
      applied: true,
      account: { email: b.account.email, alias: "bee" },
    });
    expect(valueOf((await call(client, "accounts.setDefault", { account: "bee" }, true)).result)).toMatchObject({
      applied: true,
      account: { email: b.account.email, isDefault: true },
    });

    // A new execute (a new call session) and a new browser session both see the change.
    const listed = valueOf((await call(client, "accounts.list", {}, false)).result) as { accounts: Array<{ email: string; alias?: string; isDefault: boolean }> };
    expect(listed.accounts.find((x) => x.email === b.account.email)).toMatchObject({ alias: "bee", isDefault: true });
    expect(listed.accounts.find((x) => x.email === a.account.email)).toMatchObject({ isDefault: false });
    const before = await gmailRequests(b.account.email);
    expect(valueOf((await call(client, "gmail.users.messages.list", { userId: "me", account: "bee" }, false)).result)).toBeDefined();
    expect(valueOf((await call(client, "gmail.users.messages.list", { userId: "me" }, false)).result)).toBeDefined();
    expect(await gmailRequests(b.account.email)).toBe(before + 2);
    const browser = new Browser();
    await loginCallback(browser, a.account.email);
    const page = await (await browser.fetch("/accounts")).text();
    expect(page).toContain(b.account.email);
    expect(page).toContain("bee");
    expect((await loadReadModel(env, a.userId)).account(b.account.id)).toMatchObject({ name: "bee", isDefault: true });
  });

  it("refuses setDefault unless both the new and the current default are allowed for the client", async () => {
    const { a, b, other } = await setup("mut-default");
    const before = await state(a.userId);
    // `other` is allowed B but not the current default A.
    const refused = errorOf((await call(other, "accounts.setDefault", { account: b.account.email }, true)).result);
    expect(refused.code).toBe("GWS_ACCOUNT_DENIED");
    // And never an account outside its allowlist.
    expect(errorOf((await call(other, "accounts.setDefault", { account: "work" }, true)).result).code).toBe("GWS_ACCOUNT_DENIED");
    expect(await state(a.userId)).toEqual(before);
  });
});

describe("accounts.grant", () => {
  async function userWithHiddenAccount(prefix: string) {
    const { a, b, client, other } = await setup(prefix);
    const c = await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-c`), scopes: GMAIL, userId: a.userId });
    return { a, b, c, client, other };
  }

  it("only plans in dry-run and creates no link", async () => {
    const { a, c, client } = await userWithHiddenAccount("mut-grant-dry");
    const { s, result } = await call(client, "accounts.grant", { account: c.account.email }, false);
    expect(valueOf(result)).toMatchObject({ applied: false });
    expect(JSON.stringify(valueOf(result))).not.toContain("http");
    expect(s.plan).toMatchObject([{ fn: "accounts.grant", effect: "write" }]);
    expect(await store.grants.list(a.userId, client.clientId)).not.toContain(c.account.id);
  });

  it("is a no-op for an account the client may already use", async () => {
    const { b, client } = await userWithHiddenAccount("mut-grant-noop");
    const { s, result } = await call(client, "accounts.grant", { account: b.account.email }, true);
    expect(valueOf(result)).toEqual({ applied: false, status: "already_granted", email: b.account.email });
    expect(s.plan).toEqual([]);
  });

  it("under apply returns a confirmation link and grants nothing until the human confirms on /connections", async () => {
    const { a, b, c, client } = await userWithHiddenAccount("mut-grant");
    const before = await state(a.userId);
    const out = valueOf((await call(client, "accounts.grant", { account: c.account.email }, true)).result) as Record<string, string>;
    expect(out).toMatchObject({ applied: true, status: "confirmation_required", code: "GWS_CONFIRMATION_REQUIRED" });
    expect(out.confirmUrl).toMatch(/^http:\/\/localhost\/connections\/confirm\?t=[A-Za-z0-9_-]{43}$/);
    expect(await state(a.userId)).toEqual(before);

    // The human, signed in, sees which client asks, then confirms with the session's CSRF token.
    const browser = new Browser();
    await loginCallback(browser, a.account.email);
    const confirmPath = new URL(out.confirmUrl ?? "").pathname + new URL(out.confirmUrl ?? "").search;
    const page = await (await browser.fetch(confirmPath)).text();
    expect(page).toContain(client.clientId);
    expect(page).toContain(c.account.email);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const token = new URL(out.confirmUrl ?? "").searchParams.get("t") ?? "";
    const form = (fields: Array<[string, string]>, origin = BASE) =>
      browser.fetch("/connections/confirm-grant", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin },
        body: new URLSearchParams(fields).toString(),
      });

    // Without the CSRF token nothing happens and the link stays usable.
    expect((await form([["t", token], ["account", c.account.id], ["decision", "allow"]])).status).toBe(403);
    expect(await store.grants.list(a.userId, client.clientId)).not.toContain(c.account.id);
    expect(await peekGrantRequest(env.CACHE_KV, token, a.userId)).not.toBeNull();

    const ok = await form([["csrf", csrf], ["t", token], ["account", c.account.id], ["decision", "allow"], ["client", "client-elsewhere"]]);
    expect(ok.status).toBe(303);
    expect((await store.grants.list(a.userId, client.clientId)).sort()).toEqual([a.account.id, b.account.id, c.account.id].sort());
    expect(await store.grants.list(a.userId, "client-elsewhere")).toEqual([]);
    expect(valueOf((await call(client, "accounts.scopes", { account: c.account.email }, false)).result)).toMatchObject({ email: c.account.email });

    // Used once.
    expect((await form([["csrf", csrf], ["t", token], ["account", c.account.id], ["decision", "allow"]])).status).toBe(400);
  });

  it("is consumed without a grant when the human declines", async () => {
    const { a, c, client } = await userWithHiddenAccount("mut-grant-deny");
    const out = valueOf((await call(client, "accounts.grant", { account: c.account.email }, true)).result) as { confirmUrl: string };
    const token = new URL(out.confirmUrl).searchParams.get("t") ?? "";
    const browser = new Browser();
    await loginCallback(browser, a.account.email);
    const page = await (await browser.fetch(new URL(out.confirmUrl).pathname + new URL(out.confirmUrl).search)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const res = await browser.fetch("/connections/confirm-grant", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams([["csrf", csrf], ["t", token], ["decision", "deny"]]).toString(),
    });
    expect(res.status).toBe(303);
    expect(await store.grants.list(a.userId, client.clientId)).not.toContain(c.account.id);
    expect(await peekGrantRequest(env.CACHE_KV, token, a.userId)).toBeNull();
  });
});

describe("accounts.ungrant", () => {
  it("removes the account from this client only under apply", async () => {
    const { a, b, client, other } = await setup("mut-ungrant");
    expect(valueOf((await call(client, "accounts.ungrant", { account: b.account.email }, true)).result)).toEqual({ applied: true, email: b.account.email });
    expect(await store.grants.list(a.userId, client.clientId)).toEqual([a.account.id]);
    expect(await store.grants.list(a.userId, other.clientId)).toEqual([b.account.id]);
    expect((await store.accounts.get(b.userId, b.account.id))?.status).toBe("active");
  });
});

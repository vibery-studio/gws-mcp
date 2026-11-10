import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";
import { mintMcpToken } from "../helpers/mcp-token";
import { BASE, Browser, loginCallback, pickAtFake, redirectsToGoogle, seedGoogle, signIn, userIdFor } from "../auth/browser";

const G = "https://www.googleapis.com/auth/";
const GMAIL = [`${G}gmail.readonly`, `${G}gmail.send`];
const SHEETS = `${G}spreadsheets`;
const config = loadConfig(env);
const store = openStore(env);

function call(auth: AuthProps, fn: string, input: unknown = {}) {
  return createCallSession({ ports: workersPorts(env), auth, apply: false, executeId: `x-${crypto.randomUUID()}`, config }).dispatch(fn, input);
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value, got ${JSON.stringify(r)}`);
  return r.value;
}

/** Runs one `execute` snippet through /mcp as the token's client; returns the execute output. */
async function execute(accessToken: string, code: string): Promise<{ ok: boolean; result?: unknown; plan: unknown[] }> {
  const res = await exports.default.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      host: new URL(BASE).host,
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute", arguments: { code } } }),
  });
  const body = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? (body.split("\n").filter((l) => l.startsWith("data:")).at(-1) ?? "").slice(5)
    : body;
  const text = (JSON.parse(json) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text;
  if (!text) throw new Error(`no execute result: ${res.status}`);
  return JSON.parse(text) as { ok: boolean; result?: unknown; plan: unknown[] };
}

/**
 * User with account A (gmail scopes only, default) signed in in a browser, and an MCP client allowed A only.
 * A was connected outside the browser, so it holds exactly the gmail grant at the fake.
 */
async function setup(prefix: string) {
  const a = await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-a`), scopes: GMAIL, isDefault: true });
  const browser = new Browser();
  expect((await loginCallback(browser, a.account.email)).status).toBe(302);
  const token = await mintMcpToken({ userId: a.userId, accountIds: [a.account.id] });
  const auth: AuthProps = { userId: a.userId, clientId: token.clientId };
  return { a, browser, token, auth };
}

/** Opens a connect link in `browser`, approves at the fake as `email`, and returns the final callback response. */
async function completeConnect(browser: Browser, url: string, email: string): Promise<{ google: URL; done: Response }> {
  const start = await browser.fetch(url);
  expect(redirectsToGoogle(start)).toBe(true);
  const google = new URL(start.headers.get("location") ?? "");
  return { google, done: await browser.fetch(await pickAtFake(google.toString(), email)) };
}

describe("accounts.connect", () => {
  it("connects a new account C from a snippet without changing any client's allowlist", async () => {
    const { a, browser, token, auth } = await setup("conn-new");
    const emailC = uniqueEmail("conn-new-c");
    await seedGoogle(emailC);

    // A read: it runs without apply and plans nothing.
    const out = await execute(token.accessToken, 'async () => sdk.accounts.connect({ services: ["sheets"] })');
    expect(out.ok).toBe(true);
    expect(out.plan).toEqual([]);
    const link = out.result as { url: string; expiresAt: string; note: string };
    expect(link.url).toMatch(/^http:\/\/localhost\/connect\/start\?t=[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());

    const { google, done } = await completeConnect(browser, link.url, emailC);
    expect(google.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining([SHEETS, "openid", "email"]));
    expect(google.searchParams.get("include_granted_scopes")).toBe("true");
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/accounts");

    const c = (await store.accounts.listForUser(a.userId)).find((x) => x.email === emailC);
    expect(c?.status).toBe("active");
    expect(c?.scopes).toContain(SHEETS);
    expect(await store.grants.list(a.userId, token.clientId)).toEqual([a.account.id]);
    const { results } = await env.DB.prepare("SELECT 1 FROM client_grants WHERE account_id = ?").bind(c?.id ?? "").all();
    expect(results).toEqual([]);
    // The client allowed A only is denied C.
    const denied = await call(auth, "accounts.scopes", { account: emailC });
    expect("__gwsError" in denied && denied.__gwsError.code).toBe("GWS_ACCOUNT_DENIED");
    expect(valueOf(await call(auth, "accounts.list"))).toMatchObject({ accounts: [{ email: a.account.email }], hiddenCount: 1 });
  });

  it("adds Sheets to an existing account without dropping its Gmail scopes (Google returns the whole grant)", async () => {
    const { a, browser, auth } = await setup("conn-merge");
    const link = valueOf(await call(auth, "accounts.connect", { services: ["sheets"], account: a.account.email })) as { url: string };
    const { google, done } = await completeConnect(browser, link.url, a.account.email);
    expect(google.searchParams.get("login_hint")).toBe(a.account.email);
    expect(done.status).toBe(302);
    const after = await store.accounts.get(a.userId, a.account.id);
    expect(after?.scopes).toEqual(expect.arrayContaining([...GMAIL, SHEETS]));
    expect(after?.status).toBe("active");
    expect(valueOf(await call(auth, "accounts.scopes"))).toMatchObject({ services: { gmail: true, sheets: true, drive: false } });
    // Stored scopes are exactly what Google granted, not a local merge.
    const granted = (await fake.state(a.account.email)).grants;
    expect([...(after?.scopes ?? [])].sort()).toEqual([...new Set(Object.values(granted).flat())].sort());
  });

  it("adds Forms, Tasks and Slides to an existing account: asks only their scopes and stores the whole grant", async () => {
    const { a, browser, auth } = await setup("conn-new-services");
    const link = valueOf(await call(auth, "accounts.connect", { services: ["forms", "tasks", "slides"], account: a.account.email })) as {
      url: string;
    };
    const { google, done } = await completeConnect(browser, link.url, a.account.email);
    const added = [`${G}forms.body`, `${G}forms.responses.readonly`, `${G}tasks`, `${G}presentations`];
    expect(google.searchParams.get("scope")?.split(" ").sort()).toEqual(["openid", "email", ...added].sort());
    expect(google.searchParams.get("include_granted_scopes")).toBe("true");
    expect(google.searchParams.get("login_hint")).toBe(a.account.email);
    expect(done.status).toBe(302);
    const after = await store.accounts.get(a.userId, a.account.id);
    expect(after?.status).toBe("active");
    expect(after?.scopes).toEqual(expect.arrayContaining([...GMAIL, ...added]));
    expect(valueOf(await call(auth, "accounts.scopes"))).toMatchObject({
      services: { gmail: true, forms: true, tasks: true, slides: true, drive: false, sheets: false },
    });
    // The client's allowlist is untouched by the consent.
    expect(await store.grants.list(a.userId, auth.clientId)).toEqual([a.account.id]);
  });

  it("refuses a service name outside the configured list", async () => {
    const { auth } = await setup("conn-bad-service");
    const r = await call(auth, "accounts.connect", { services: ["keep"] });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_INVALID_INPUT");
  });

  it("pre-selects only an allowed account, and refuses one the client may not use", async () => {
    const { a, auth } = await setup("conn-hint");
    const other = await seedUserWithAccount(env, { email: uniqueEmail("conn-hint-b"), scopes: GMAIL, userId: a.userId });
    const denied = await call(auth, "accounts.connect", { services: ["sheets"], account: other.account.email });
    expect("__gwsError" in denied && denied.__gwsError.code).toBe("GWS_ACCOUNT_DENIED");
  });

  it("ignores a hint for an email that is not the user's own account", async () => {
    const { browser, auth } = await setup("conn-foreign-hint");
    const link = valueOf(await call(auth, "accounts.connect", { services: ["docs"] })) as { url: string };
    const start = await browser.fetch(`${link.url}&hint=${encodeURIComponent("victim@elsewhere.test")}`);
    expect(redirectsToGoogle(start)).toBe(true);
    expect(new URL(start.headers.get("location") ?? "").searchParams.get("login_hint")).toBeNull();
  });

  it("works once only, and only for the user it was issued to", async () => {
    const { auth, browser } = await setup("conn-once");
    const intruderEmail = uniqueEmail("conn-once-intruder");
    await seedGoogle(intruderEmail);
    const intruder = new Browser();
    await signIn(intruder, intruderEmail);

    const stolen = valueOf(await call(auth, "accounts.connect", { services: ["sheets"] })) as { url: string };
    const refused = await intruder.fetch(stolen.url);
    expect(refused.status).toBe(400);
    expect(redirectsToGoogle(refused)).toBe(false);
    // Presented once, by anyone, it is used up.
    expect((await browser.fetch(stolen.url)).status).toBe(400);

    const link = valueOf(await call(auth, "accounts.connect", { services: ["sheets"] })) as { url: string };
    expect(redirectsToGoogle(await browser.fetch(link.url))).toBe(true);
    const again = await browser.fetch(link.url);
    expect(again.status).toBe(400);
    expect(redirectsToGoogle(again)).toBe(false);
  });

  it("sends a browser without a session to sign in first, without using the link up", async () => {
    const { a, auth } = await setup("conn-login");
    const link = valueOf(await call(auth, "accounts.connect", { services: ["sheets"] })) as { url: string };
    const browser = new Browser();
    const res = await browser.fetch(link.url);
    expect(res.status).toBe(302);
    const path = new URL(link.url).pathname + new URL(link.url).search;
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
    const back = await loginCallback(browser, a.account.email, path);
    expect(back.headers.get("location")).toBe(path);
    expect(redirectsToGoogle(await browser.fetch(link.url))).toBe(true);
    expect(userIdFor(a.sub)).toBe(a.userId);
  });
});

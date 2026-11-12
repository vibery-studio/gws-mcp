import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, safeNext, startGoogleAuth } from "../../src/auth/google-flow";
import { sha256Hex } from "../../src/auth/session";
import { DEFAULT_CONNECT_SERVICES, FAKE_CLIENT_ID, GOOGLE_SERVICES, SERVICE_SCOPES } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { openStore } from "../../src/store/db";
import { webApp } from "../../src/web/app";
import routesSource from "../../src/auth/routes.ts?raw";
import { fakeTransport } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";
import {
  BASE,
  Browser,
  approveClient,
  config,
  defaultAccount,
  grantRows,
  loginCallback,
  pickAtFake,
  redirectsToGoogle,
  seedGoogle,
  signIn,
  startLogin,
  userIdFor,
} from "./browser";

const G = "https://www.googleapis.com/auth/";

/** The user id a browser's session belongs to, read the way the server reads it. */
async function sessionUser(browser: Browser): Promise<string | null> {
  const id = browser.cookies.get("__Host-gws_session");
  if (!id) return null;
  const raw = await env.CACHE_KV.get(`sess:${await sha256Hex(id)}`);
  return raw ? (JSON.parse(raw) as { userId: string }).userId : null;
}

async function tokenCalls(email: string): Promise<number> {
  return (await fake.requests(email)).filter((r) => r.path === "/oauth2.googleapis.com/token").length;
}

/** A browser whose requests the web app answers with LOGIN_ACCOUNTS=active. */
function activePolicyBrowser(): Browser {
  return new Browser(async (r) => webApp.fetch(r, { ...env, LOGIN_ACCOUNTS: "active" } as Env));
}

/** Whether the fake's authorization code in a callback URL will be answered with a refresh token. */
function codeIssuesRefresh(callback: string): boolean {
  const body = (new URL(callback).searchParams.get("code") ?? "").split(".")[0] ?? "";
  const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
  return (JSON.parse(json) as { issueRefresh: boolean }).issueRefresh;
}

/** Starts a connect round trip the way the connections page does, in `browser`; returns Google's callback URL. */
async function startConnect(browser: Browser, userId: string, email: string): Promise<string> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/start", (c) => startGoogleAuth(c, { purpose: "connect", userId, scopes: [`${G}drive.file`], loginHint: email, next: DEFAULT_NEXT }));
  const res = await app.request("/start", {}, env);
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    browser.cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  }
  return pickAtFake(res.headers.get("location") ?? "", email);
}

/** User A (signed in, in the returned browser) with a second account C connected through the real round trip. */
async function userWithSecondAccount(prefix: string): Promise<{ browser: Browser; userId: string; emailC: string; accountC: string }> {
  const a = uniqueEmail(`${prefix}-a`);
  const emailC = uniqueEmail(`${prefix}-c`);
  const subA = await seedGoogle(a);
  await seedGoogle(emailC);
  const browser = new Browser();
  await signIn(browser, a);
  const userId = userIdFor(subA);
  expect((await browser.fetch(await startConnect(browser, userId, emailC))).status).toBe(302);
  const accountC = (await openStore(env).accounts.listForUser(userId)).find((x) => x.email === emailC);
  expect(accountC?.status).toBe("active");
  return { browser, userId, emailC, accountC: accountC?.id ?? "" };
}

describe("starting Google sign-in", () => {
  it("redirects to Google with the configured callback, whatever host the request names", async () => {
    const browser = new Browser();
    const res = await browser.fetch("http://attacker.example/login");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin).toBe(config.FAKE_GOOGLE_PUBLIC_URL);
    expect(url.pathname).toBe("/accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(`${config.PUBLIC_BASE_URL}/google/callback`);
    expect(url.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid"]);
  });

  it("asks Google for online access with the account chooser, so sign-in never mints a refresh token", async () => {
    const url = await startLogin(new Browser());
    expect(url.searchParams.get("access_type")).toBe("online");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid"]);
  });

  it("binds a random state to a __Host- cookie and stores only its hash, for 10 minutes", async () => {
    const browser = new Browser();
    const res = await browser.fetch("/login");
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-gws_gstate=")) ?? "";
    expect(cookie.startsWith(`__Host-gws_gstate=${state};`)).toBe(true);
    const attrs = cookie.split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["secure", "httponly", "samesite=lax", "path=/", "max-age=600"]));
    expect(await env.CACHE_KV.get(`gstate:${state}`)).toBeNull();
    const stored = await env.CACHE_KV.get(`gstate:${await sha256Hex(state)}`);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(state);
  });
});

describe("Google callback state rules", () => {
  it("round-trips a valid state against the fake and signs the user in", async () => {
    const email = uniqueEmail("flow-ok");
    const sub = await seedGoogle(email);
    const browser = new Browser();
    const res = await signIn(browser, email);
    expect(res.status).toBe(302);
    // A first sign-in continues into connecting the account, which ends on Home.
    expect(res.headers.get("location")).toBe("/");
    expect(await sessionUser(browser)).toBe(userIdFor(sub));
    expect(browser.cookies.has("__Host-gws_gstate")).toBe(false);
  });

  it("refuses a callback without the state cookie, and leaves the state usable by its own browser", async () => {
    const email = uniqueEmail("flow-nocookie");
    await seedGoogle(email);
    const browser = new Browser();
    const callback = await pickAtFake((await startLogin(browser)).toString(), email);
    const stateCookie = browser.cookies.get("__Host-gws_gstate") ?? "";
    browser.cookies.delete("__Host-gws_gstate");
    const res = await browser.fetch(callback);
    expect(res.status).toBe(400);
    expect(browser.cookies.has("__Host-gws_session")).toBe(false);
    // Another browser presenting the URL did not consume it.
    browser.cookies.set("__Host-gws_gstate", stateCookie);
    expect((await browser.fetch(callback)).status).toBe(302);
  });

  it("refuses a state that does not match this browser's cookie", async () => {
    const email = uniqueEmail("flow-mismatch");
    await seedGoogle(email);
    const victim = new Browser();
    const attacker = new Browser();
    await startLogin(victim);
    const attackerCallback = await pickAtFake((await startLogin(attacker)).toString(), email);
    const res = await victim.fetch(attackerCallback);
    expect(res.status).toBe(400);
    expect(victim.cookies.has("__Host-gws_session")).toBe(false);
  });

  it("refuses a reused state without exchanging the code again", async () => {
    const email = uniqueEmail("flow-reuse");
    await seedGoogle(email);
    const browser = new Browser();
    const callback = await pickAtFake((await startLogin(browser)).toString(), email);
    const stateCookie = browser.cookies.get("__Host-gws_gstate") ?? "";
    expect((await browser.fetch(callback)).status).toBe(302);
    const exchanges = await tokenCalls(email);
    const replay = new Browser();
    replay.cookies.set("__Host-gws_gstate", stateCookie);
    const res = await replay.fetch(callback);
    expect(res.status).toBe(400);
    expect(replay.cookies.has("__Host-gws_session")).toBe(false);
    expect(await tokenCalls(email)).toBe(exchanges);
  });

  it("refuses an expired state", async () => {
    const email = uniqueEmail("flow-expired");
    await seedGoogle(email);
    const browser = new Browser();
    const authUrl = await startLogin(browser);
    const key = `gstate:${await sha256Hex(authUrl.searchParams.get("state") ?? "")}`;
    const record = JSON.parse((await env.CACHE_KV.get(key)) ?? "{}") as Record<string, unknown>;
    await env.CACHE_KV.put(key, JSON.stringify({ ...record, exp: Date.now() - 1 }));
    const res = await browser.fetch(await pickAtFake(authUrl.toString(), email));
    expect(res.status).toBe(400);
    expect(browser.cookies.has("__Host-gws_session")).toBe(false);
  });

  it("renders an error page when Google returns an error, and signs nobody in", async () => {
    const email = uniqueEmail("flow-denied");
    await seedGoogle(email);
    const browser = new Browser();
    const callback = await pickAtFake((await startLogin(browser)).toString(), email, "deny");
    expect(new URL(callback).searchParams.get("error")).toBe("access_denied");
    const res = await browser.fetch(callback);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("cancelled");
    expect(browser.cookies.has("__Host-gws_session")).toBe(false);
  });
});

describe("the next parameter", () => {
  it.each(["//evil.example", "https://evil.example", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "evil", "/\tevil", ""])(
    "falls back to the default page for %j",
    async (next) => {
      const email = uniqueEmail("flow-next");
      await seedGoogle(email);
      const res = await signIn(new Browser(), email, next);
      expect(res.status).toBe(302);
      // The fallback is the default page, so the first sign-in's connection ends on Home.
      const location = new URL(res.headers.get("location") ?? "", BASE);
      expect(`${location.origin}${location.pathname}`).toBe(`${BASE}/`);
    },
  );

  it("lands a returning sign-in on Home when no page asked for another", async () => {
    expect(DEFAULT_NEXT).toBe("/");
    for (const unsafe of [undefined, "", "//evil.example", "https://evil.example"]) expect(safeNext(unsafe)).toBe("/");
    const email = uniqueEmail("flow-next-home");
    await seedGoogle(email);
    await signIn(new Browser(), email);
    const res = await loginCallback(new Browser(), email);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("keeps a same-origin path with its query", async () => {
    const email = uniqueEmail("flow-next-ok");
    await seedGoogle(email);
    const res = await signIn(new Browser(), email, "/authorize?client_id=x&state=y");
    expect(res.headers.get("location")).toBe("/authorize?client_id=x&state=y");
  });
});

describe("sign-in identity", () => {
  it("resolves a returning user by Google sub and issues a fresh session id each time", async () => {
    const email = uniqueEmail("flow-return");
    const sub = await seedGoogle(email);
    const browser = new Browser();
    await signIn(browser, email);
    const first = browser.cookies.get("__Host-gws_session");
    await signIn(browser, email);
    expect(browser.cookies.get("__Host-gws_session")).not.toBe(first);
    expect(await sessionUser(browser)).toBe(userIdFor(sub));
    expect(await env.CACHE_KV.get(`sess:${await sha256Hex(first ?? "")}`)).toBeNull();
    const accounts = await openStore(env).accounts.listForUser(userIdFor(sub));
    expect(accounts.map((a) => [a.email, a.isDefault])).toEqual([[email, true]]);
  });

  it("never lets a reissued address (same email, new sub) take over the old owner's user", async () => {
    const email = uniqueEmail("flow-reissued");
    const oldSub = await seedGoogle(email);
    await signIn(new Browser(), email);
    await fake.reset(email);
    await seedGoogle(email, `${oldSub}9`);
    const newcomer = new Browser();
    const res = await signIn(newcomer, email);
    expect(res.status).toBe(409);
    expect(newcomer.cookies.has("__Host-gws_session")).toBe(false);
    expect(await openStore(env).users.findById(userIdFor(`${oldSub}9`))).toBeNull();
  });

  it("makes a second Google account that is not connected its own separate user", async () => {
    const a = uniqueEmail("flow-first");
    const b = uniqueEmail("flow-second");
    const subA = await seedGoogle(a);
    const subB = await seedGoogle(b);
    const browserA = new Browser();
    const browserB = new Browser();
    await signIn(browserA, a);
    await signIn(browserB, b);
    expect(await sessionUser(browserA)).toBe(userIdFor(subA));
    expect(await sessionUser(browserB)).toBe(userIdFor(subB));
  });
});

describe("connecting another account", () => {
  it("adds the account with the granted scopes and leaves every client allowlist unchanged", async () => {
    const a = uniqueEmail("connect-a");
    const c2 = uniqueEmail("connect-c");
    const subA = await seedGoogle(a);
    await seedGoogle(c2);
    const browser = new Browser();
    await signIn(browser, a);
    const userId = userIdFor(subA);
    const client = await approveClient(browser, "Allowlist client", defaultAccount);
    const before = await grantRows(userId, client.clientId);
    expect(before).toHaveLength(1);

    const res = await browser.fetch(await startConnect(browser, userId, c2));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/accounts");
    const connected = (await openStore(env).accounts.listForUser(userId)).find((x) => x.email === c2);
    expect(connected?.isDefault).toBe(false);
    expect([...(connected?.scopes ?? [])].sort()).toEqual(["email", `${G}drive.file`, "openid"]);
    expect(await grantRows(userId, client.clientId)).toEqual(before);
    const { results } = await env.DB.prepare("SELECT 1 FROM client_grants WHERE account_id = ?").bind(connected?.id ?? "").all();
    expect(results).toHaveLength(0);
  });

  it("refuses with 403 when the signed-in user is not the one who started the connection", async () => {
    const a = uniqueEmail("connect-owner");
    const other = uniqueEmail("connect-other");
    const c2 = uniqueEmail("connect-target");
    const subA = await seedGoogle(a);
    await seedGoogle(other);
    await seedGoogle(c2);
    const browser = new Browser();
    await signIn(browser, other);
    const callback = await startConnect(browser, userIdFor(subA), c2);
    expect(codeIssuesRefresh(callback)).toBe(true);
    const res = await browser.fetch(callback);
    expect(res.status).toBe(403);
    expect((await openStore(env).accounts.listForUser(userIdFor(subA))).some((x) => x.email === c2)).toBe(false);
    // The refresh token Google minted for the refused connection is revoked, not left dangling.
    expect((await fake.requests(c2)).filter((r) => r.path === "/oauth2.googleapis.com/revoke")).toHaveLength(1);
    expect((await fake.state(c2)).grants).toEqual({});
  });

  it("does not revoke a refused connection's token when the account is stored with a token: the Google grant is shared", async () => {
    const { userId, emailC, accountC } = await userWithSecondAccount("connect-refused-stored");
    const stranger = uniqueEmail("connect-refused-stranger");
    await seedGoogle(stranger);
    const browser = new Browser();
    await signIn(browser, stranger);
    const res = await browser.fetch(await startConnect(browser, userId, emailC));
    expect(res.status).toBe(403);
    expect((await fake.requests(emailC)).some((r) => r.path === "/oauth2.googleapis.com/revoke")).toBe(false);
    const stored = await openStore(env).accounts.getRefreshToken(userId, accountC);
    await expect(googleOAuth(env, fakeTransport).refresh(stored)).resolves.toBeDefined();
  });

  it("renders an error page when the account belongs to another user", async () => {
    const a = uniqueEmail("connect-mine");
    const taken = uniqueEmail("connect-taken");
    const subA = await seedGoogle(a);
    await seedGoogle(taken);
    await signIn(new Browser(), taken);
    const browser = new Browser();
    await signIn(browser, a);
    const res = await browser.fetch(await startConnect(browser, userIdFor(subA), taken));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("another gws-mcp user");
    // Never revoked: the Google grant is shared with the other user's stored token.
    expect((await fake.requests(taken)).some((r) => r.path === "/oauth2.googleapis.com/revoke")).toBe(false);
    expect(Object.keys((await fake.state(taken)).grants)).toHaveLength(1);
  });
});

describe("first sign-in", () => {
  it("creates the user and its account without a token, then goes straight into connecting it", async () => {
    const email = uniqueEmail("first");
    const sub = await seedGoogle(email);
    const browser = new Browser();
    const res = await loginCallback(browser, email, "/authorize?client_id=x");
    expect(redirectsToGoogle(res)).toBe(true);
    const connectUrl = new URL(res.headers.get("location") ?? "");
    expect(connectUrl.searchParams.get("access_type")).toBe("offline");
    expect(connectUrl.searchParams.get("prompt")).toBe("consent");
    expect(connectUrl.searchParams.get("login_hint")).toBe(email);
    const preset = SERVICE_SCOPES[config.GOOGLE_SCOPE_PRESET];
    const oneClick = DEFAULT_CONNECT_SERVICES.flatMap((s) => preset[s]);
    const asked = connectUrl.searchParams.get("scope")?.split(" ") ?? [];
    expect([...new Set(asked)].sort()).toEqual([...new Set(["openid", "email", ...oneClick])].sort());
    // The opt-in services are never part of a first sign-in: money, Workspace admin, Analytics and Tag Manager changes.
    const optIn = GOOGLE_SERVICES.filter((s) => !DEFAULT_CONNECT_SERVICES.includes(s));
    expect([...optIn].sort()).toEqual(["ads", "analyticsadmin", "groups", "tagmanageradmin", "tagmanageredit", "tagmanagerpublish"]);
    for (const scope of optIn.flatMap((s) => preset[s])) expect(asked, scope).not.toContain(scope);
    for (const banned of ["adwords", "analytics.edit", "tagmanager.edit.", "tagmanager.publish", "tagmanager.manage.", "tagmanager.delete.", "admin.directory.", "apps.groups."]) {
      expect(asked.filter((scope) => scope.includes(banned)), banned).toEqual([]);
    }
    expect(await sessionUser(browser)).toBe(userIdFor(sub));
    const [created] = await openStore(env).accounts.listForUser(userIdFor(sub));
    expect([created?.email, created?.status, created?.hasRefreshToken, created?.isDefault]).toEqual([email, "reconnect", false, true]);

    const done = await browser.fetch(await pickAtFake(connectUrl.toString(), email));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/authorize?client_id=x");
    const [connected] = await openStore(env).accounts.listForUser(userIdFor(sub));
    expect([connected?.id, connected?.status, connected?.hasRefreshToken]).toEqual([created?.id, "active", true]);
  });

  it("ends first-time setup on Home, which shows the connected account in its flash", async () => {
    const email = uniqueEmail("first-home");
    await seedGoogle(email);
    const browser = new Browser();
    const done = await signIn(browser, email);
    expect([done.status, done.headers.get("location")]).toEqual([302, "/"]);
    const home = await (await browser.fetch("/")).text();
    expect(/<div class="flash flash-success" role="status"><p>([^<]*)<\/p><\/div>/.exec(home)?.[1]).toBe(`${email} is connected.`);
    expect(await (await browser.fetch("/")).text()).not.toContain('class="flash flash-success"');
  });

  it("ends any later connect on Google accounts with its flash: another account, or the sign-in account reconnected", async () => {
    const email = uniqueEmail("later-connect-a");
    const other = uniqueEmail("later-connect-b");
    const sub = await seedGoogle(email);
    await seedGoogle(other);
    const browser = new Browser();
    await signIn(browser, email);
    const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/accounts")).text())?.[1] ?? "";
    const connect = async (as: string, account?: string) => {
      const start = await browser.fetch("/connections/connect", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
        body: new URLSearchParams([["csrf", csrf], ["service", "drive"], ...(account ? [["account", account]] : [])]).toString(),
      });
      expect(redirectsToGoogle(start)).toBe(true);
      return browser.fetch(await pickAtFake(start.headers.get("location") ?? "", as));
    };

    const added = await connect(other);
    expect([added.status, added.headers.get("location")]).toEqual([302, "/accounts"]);
    expect(await (await browser.fetch("/accounts")).text()).toContain(`${other} is connected.`);

    const store = openStore(env);
    const [primary] = (await store.accounts.listForUser(userIdFor(sub))).filter((a) => a.email === email);
    await store.accounts.wipeToken(userIdFor(sub), primary?.id ?? "");
    const reconnected = await connect(email, primary?.id);
    expect([reconnected.status, reconnected.headers.get("location")]).toEqual([302, "/accounts"]);
    expect(await (await browser.fetch("/accounts")).text()).toContain(`${email} is connected.`);
  });

  it("ignores a refresh token the login exchange returns, even when Google issues one", async () => {
    const email = uniqueEmail("first-offline");
    const sub = await seedGoogle(email);
    const browser = new Browser();
    const authUrl = await startLogin(browser);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    const callback = await pickAtFake(authUrl.toString(), email);
    expect(codeIssuesRefresh(callback)).toBe(true);
    expect(redirectsToGoogle(await browser.fetch(callback))).toBe(true);
    const [account] = await openStore(env).accounts.listForUser(userIdFor(sub));
    expect([account?.status, account?.hasRefreshToken]).toEqual(["reconnect", false]);
  });

  it("gets no refresh token from the untampered login exchange", async () => {
    const email = uniqueEmail("first-online");
    await seedGoogle(email);
    const callback = await pickAtFake((await startLogin(new Browser())).toString(), email);
    expect(codeIssuesRefresh(callback)).toBe(false);
  });

  it("refuses an email held by another user's account before creating anything", async () => {
    const { emailC } = await userWithSecondAccount("first-taken");
    await fake.reset(emailC);
    const newSub = await seedGoogle(emailC);
    const browser = new Browser();
    const res = await loginCallback(browser, emailC);
    expect(res.status).toBe(409);
    expect(browser.cookies.has("__Host-gws_session")).toBe(false);
    expect(await openStore(env).users.findById(userIdFor(newSub))).toBeNull();
  });

  it("checks the email through the store: the auth routes run no SQL of their own", () => {
    expect(routesSource).toContain("accounts.emailInUse(");
    expect(routesSource).not.toMatch(/\.prepare\(|\bSELECT\b|\bD1Database\b/);
  });
});

describe("who may sign in", () => {
  it("refuses a disconnected secondary account under either setting, and creates no session", async () => {
    const { userId, emailC, accountC } = await userWithSecondAccount("policy-disconnected");
    await openStore(env).accounts.wipeToken(userId, accountC);
    for (const browser of [new Browser(), activePolicyBrowser()]) {
      const res = await loginCallback(browser, emailC);
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      expect(browser.cookies.has("__Host-gws_session")).toBe(false);
    }
  });

  it("lets a disconnected primary account sign in under either setting, without reviving it", async () => {
    const email = uniqueEmail("policy-primary-gone");
    const sub = await seedGoogle(email);
    await signIn(new Browser(), email);
    const store = openStore(env);
    const [primary] = await store.accounts.listForUser(userIdFor(sub));
    const wiped = await store.accounts.wipeToken(userIdFor(sub), primary?.id ?? "");
    const stored = (a: typeof wiped | null | undefined) => [a?.status, a?.hasRefreshToken, a?.tokenGeneration, a?.scopes];
    expect(stored(wiped)).toEqual(["disconnected", false, null, []]);
    for (const browser of [new Browser(), activePolicyBrowser()]) {
      const res = await loginCallback(browser, email);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(await sessionUser(browser)).toBe(userIdFor(sub));
      expect(stored(await store.accounts.get(userIdFor(sub), primary?.id ?? ""))).toEqual(stored(wiped));
    }
  });

  it("lets an active secondary account sign in while the primary is disconnected only under LOGIN_ACCOUNTS active", async () => {
    const { userId, emailC } = await userWithSecondAccount("policy-secondary-primary-gone");
    const store = openStore(env);
    const primary = (await store.accounts.listForUser(userId)).find((a) => a.email !== emailC);
    await store.accounts.wipeToken(userId, primary?.id ?? "");
    const refused = new Browser();
    expect((await loginCallback(refused, emailC)).status).toBe(403);
    expect(refused.cookies.has("__Host-gws_session")).toBe(false);
    const allowed = activePolicyBrowser();
    expect((await loginCallback(allowed, emailC)).status).toBe(302);
    expect(await sessionUser(allowed)).toBe(userId);
  });

  it("refuses a secondary account in reconnect state even under LOGIN_ACCOUNTS active", async () => {
    const { userId, emailC, accountC } = await userWithSecondAccount("policy-reconnect");
    await openStore(env).accounts.markStatus(userId, accountC, "reconnect");
    const browser = activePolicyBrowser();
    const res = await loginCallback(browser, emailC);
    expect(res.status).toBe(403);
    expect(browser.cookies.has("__Host-gws_session")).toBe(false);
  });

  it("refuses an active secondary account by default (primary only)", async () => {
    const { emailC } = await userWithSecondAccount("policy-primary");
    const browser = new Browser();
    const res = await loginCallback(browser, emailC);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("primary");
    expect(browser.cookies.has("__Host-gws_session")).toBe(false);
  });

  it("lets an active secondary account sign in as its user when LOGIN_ACCOUNTS is active", async () => {
    const { userId, emailC } = await userWithSecondAccount("policy-active");
    const browser = activePolicyBrowser();
    const res = await loginCallback(browser, emailC);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(await sessionUser(browser)).toBe(userId);
  });

  it("lets the primary account sign in again under either setting", async () => {
    const email = uniqueEmail("policy-primary-ok");
    const sub = await seedGoogle(email);
    await signIn(new Browser(), email);
    for (const browser of [new Browser(), activePolicyBrowser()]) {
      const res = await loginCallback(browser, email);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(await sessionUser(browser)).toBe(userIdFor(sub));
    }
  });
});

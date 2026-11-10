import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { providerOptions } from "../../src/auth/provider-options";
import { peekGrantRequest } from "../../src/core/accounts-capability";
import { googleOAuth } from "../../src/google/oauth";
import { mcpApiHandler } from "../../src/mcp/server";
import { openStore } from "../../src/store/db";
import { webApp } from "../../src/web/app";
import { COPY, SERVICE_NAMES } from "../../src/web/copy";
import { loadReadModel } from "../../src/web/read-model";
import { fakeTransport, seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import {
  BASE,
  Browser,
  approveClient,
  defaultAccount,
  grantRows,
  loginCallback,
  mcpToolsList,
  pickAtFake,
  redirectsToGoogle,
  seedGoogle,
  signIn,
  userIdFor,
} from "../auth/browser";

const store = openStore(env);
const providerConfig = { ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp };
const helpers = getOAuthApi(providerConfig, env);

/**
 * OAUTH_KV as Cloudflare's eventually consistent KV list can show it for up to a minute after a write: listing
 * grant keys returns nothing yet. Reads, writes and other listings (a grant's tokens) behave normally.
 */
const staleGrantListingKv = new Proxy(env.OAUTH_KV, {
  get(target, key) {
    if (key === "list") {
      return (options?: KVNamespaceListOptions) =>
        options?.prefix?.startsWith("grant:") ? Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }) : target.list(options);
    }
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
});
/** The web app with the provider's helpers over that KV, as the deployed Worker sees it right after a consent. */
const staleHelpers = getOAuthApi(providerConfig, { ...env, OAUTH_KV: staleGrantListingKv });
const staleEnv = { ...env, OAUTH_PROVIDER: staleHelpers } as Env;
const staleBrowser = () => new Browser(async (r) => webApp.fetch(r, staleEnv));

/** POSTs a form the way a browser does from a page of this site: with this site's Origin. */
function post(browser: Browser, path: string, fields: Array<[string, string]>, origin: string | null = BASE): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The CSRF token a signed-in page embeds in its forms (the sign-out form of the page shell). */
async function csrfOf(browser: Browser): Promise<string> {
  const page = await (await browser.fetch("/accounts")).text();
  const m = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(page);
  if (!m?.[1]) throw new Error("accounts page has no csrf field");
  return m[1];
}

/** The flash a page shows, or undefined. */
function flashOf(page: string): string | undefined {
  return /<div class="flash [^"]+" role="(?:status|alert)">([\s\S]*?)<\/div>/.exec(page)?.[1];
}

/**
 * A signed-in user with A (primary, default) and C (connected through the real round trip), and one approved
 * client allowed A. Returns the browser, ids and the client's access token.
 */
async function signedInWithTwoAccounts(prefix: string) {
  const emailA = uniqueEmail(`${prefix}-a`);
  const emailC = uniqueEmail(`${prefix}-c`);
  const subA = await seedGoogle(emailA);
  await seedGoogle(emailC);
  const browser = new Browser();
  await signIn(browser, emailA);
  const userId = userIdFor(subA);
  const client = await approveClient(browser, `Client ${prefix}`, defaultAccount);
  const csrf = await csrfOf(browser);
  const start = await post(browser, "/connections/connect", [["csrf", csrf], ["service", "sheets"]]);
  expect(redirectsToGoogle(start)).toBe(true);
  expect((await browser.fetch(await pickAtFake(start.headers.get("location") ?? "", emailC))).status).toBe(302);
  const accounts = await store.accounts.listForUser(userId);
  const a = accounts.find((x) => x.email === emailA);
  const c = accounts.find((x) => x.email === emailC);
  if (!a || !c) throw new Error("setup accounts missing");
  return { browser, userId, csrf, client, a, c };
}

/** Everything a /connections action could change for `userId`. */
async function snapshot(userId: string) {
  const accounts = await store.accounts.listForUser(userId);
  const { results: grants } = await env.DB.prepare("SELECT client_id, account_id FROM client_grants WHERE user_id = ? ORDER BY client_id, account_id")
    .bind(userId)
    .all();
  const { items } = await helpers.listUserGrants(userId);
  return { accounts, grants, oauthGrants: items.map((g) => g.id).sort() };
}

describe("/connections access", () => {
  it("sends a browser without a session to sign in, keeping the page as next", async () => {
    const old = await new Browser().fetch("/connections?connected=x");
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/accounts");
    const res = await new Browser().fetch("/accounts");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/accounts")}`);
    const confirm = await new Browser().fetch(`/connections/confirm?t=${"a".repeat(43)}`);
    expect(confirm.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/connections/confirm?t=${"a".repeat(43)}`)}`);
  });

  it("refuses a POST without a session and changes nothing", async () => {
    const { userId, a } = await signedInWithTwoAccounts("web-nosession");
    const before = await snapshot(userId);
    const res = await post(new Browser(), "/connections/disconnect", [["csrf", "x"], ["account", a.id]]);
    expect(res.status).toBe(401);
    expect(await snapshot(userId)).toEqual(before);
  });
});

describe("/connections content on the new pages", () => {
  it("lists the user's accounts and approved apps, escaping app names, with no script and no framing", async () => {
    const emailA = uniqueEmail("web-page");
    const subA = await seedGoogle(emailA);
    const browser = new Browser();
    await signIn(browser, emailA);
    const userId = userIdFor(subA);
    const evil = '<script>alert(1)</script>‮gnp.exe';
    const client = await approveClient(browser, evil, defaultAccount);
    const [account] = await store.accounts.listForUser(userId);
    await store.accounts.setAlias(userId, account?.id ?? "", "home");

    for (const path of ["/accounts", "/apps"]) {
      const res = await browser.fetch(`${path}?connected=${encodeURIComponent("<b>x</b>")}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("cache-control")).toBe("no-store");
      // A same-origin form POST carries a real Origin only when the page's referrer policy is not no-referrer.
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      const page = await res.text();
      expect(page).not.toContain("<script");
      expect(page).not.toContain("‮");
      expect(page).not.toContain("<b>x</b>");
      expect(page).toContain('<meta name="referrer" content="same-origin">');
      expect(page).toMatch(/<form method="post" action="\/logout"[^>]*>\s*<input type="hidden" name="csrf" value="[^"]+">/);
    }
    const accounts = await (await browser.fetch("/accounts")).text();
    expect(accounts).toContain(emailA);
    expect(accounts).toContain("home");
    expect(accounts).toContain(COPY.chips.default);
    expect(accounts).toContain(COPY.status.active);
    expect(accounts).toContain(SERVICE_NAMES.gmail);
    const apps = await (await browser.fetch("/apps")).text();
    expect(apps).toContain(`href="/apps/${encodeURIComponent(client.clientId)}"`);
    expect(apps).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("/connections notices", () => {
  it("names a just-connected account only through the flash its own connection set, never from the URL", async () => {
    const s = await signedInWithTwoAccounts("web-notice");
    // The setup's connection of C left a flash naming C; it shows once.
    const first = await (await s.browser.fetch("/accounts")).text();
    expect(flashOf(first)).toContain(s.c.email);
    const other = uniqueEmail("web-notice-other");
    for (const connected of [s.c.email.toUpperCase(), "SECURITY ALERT: re-authorize at evil.example now", other, ""]) {
      for (const path of ["/accounts", "/connections"]) {
        const res = await s.browser.fetch(`${path}?connected=${encodeURIComponent(connected)}`);
        const page = res.status === 303 ? await (await s.browser.fetch(res.headers.get("location") ?? "")).text() : await res.text();
        expect(flashOf(page)).toBeUndefined();
        expect(page).not.toContain("SECURITY ALERT");
      }
    }
  });

  it("strips bidi and other invisible format characters from a grant request's hint", async () => {
    const s = await signedInWithTwoAccounts("web-hint");
    const hint = "pay\u202Emoc.live\u200B@x\u2066";
    const token = await grantLink(s.userId, s.client.clientId, hint);
    const page = await (await s.browser.fetch(`/connections/confirm?t=${token}`)).text();
    expect(page).toContain("The app asked for: paymoc.live@x</p>");
    expect(page).not.toMatch(/[\u202E\u200B\u2066]/);
  });
});

/** Every POST action with fields that would succeed for the given setup. */
function actions(s: Awaited<ReturnType<typeof signedInWithTwoAccounts>>, grantToken: string): Array<[string, Array<[string, string]>]> {
  // In an order where each succeeds after the previous ones did.
  return [
    ["/connections/connect", [["service", "drive"]]],
    ["/connections/set-default", [["account", s.c.id]]],
    ["/connections/alias", [["account", s.c.id], ["alias", "renamed"]]],
    ["/connections/client-grant", [["client", s.client.clientId], ["account", s.c.id]]],
    ["/connections/client-ungrant", [["client", s.client.clientId], ["account", s.a.id]]],
    ["/connections/confirm-grant", [["t", grantToken], ["account", s.c.id], ["decision", "allow"]]],
    ["/connections/client-revoke", [["client", s.client.clientId]]],
    ["/connections/disconnect", [["account", s.c.id]]],
  ];
}

/** A pending grant request of the setup's client, as `accounts.grant` would create it. */
async function grantLink(userId: string, clientId: string, hint?: string): Promise<string> {
  const { createAccountsCapability } = await import("../../src/core/accounts-capability");
  const cap = createAccountsCapability({
    store,
    auth: { userId, clientId },
    apply: true,
    config: { PUBLIC_BASE_URL: BASE },
    kv: env.CACHE_KV,
    oauth: googleOAuth(env, fakeTransport),
    upstream: (fn) => fn(),
    invalidateToken: async () => undefined,
    now: () => Date.now(),
    plan: () => "s1",
    applied: () => undefined,
  });
  const w = await cap.requestGrant(hint);
  if (!w.applied) throw new Error("grant request was only planned");
  return new URL(w.value.url).searchParams.get("t") ?? "";
}

describe("/connections POST protection", () => {
  const cases: Array<[string, (csrf: string) => { csrf?: string; origin: string | null }]> = [
    ["no CSRF token", () => ({ origin: BASE })],
    ["a wrong CSRF token", () => ({ csrf: "x".repeat(43), origin: BASE })],
    ["another site's Origin", (csrf) => ({ csrf, origin: "https://evil.example" })],
    ["an opaque null Origin", (csrf) => ({ csrf, origin: "null" })],
    ["no Origin", (csrf) => ({ csrf, origin: null })],
  ];

  it.each(cases)("refuses every action with %s, changing nothing", async (_label, attempt) => {
    const s = await signedInWithTwoAccounts("web-csrf");
    const token = await grantLink(s.userId, s.client.clientId);
    const before = await snapshot(s.userId);
    const { csrf, origin } = attempt(s.csrf);
    for (const [path, fields] of actions(s, token)) {
      const res = await post(s.browser, path, [...(csrf === undefined ? [] : [["csrf", csrf] as [string, string]]), ...fields], origin);
      expect([path, res.status]).toEqual([path, 403]);
      expect(redirectsToGoogle(res)).toBe(false);
    }
    expect(await snapshot(s.userId)).toEqual(before);
    expect(await peekGrantRequest(env.CACHE_KV, token, s.userId)).not.toBeNull();
    expect(await mcpToolsList(s.client.accessToken)).toBe(200);
  });

  it("accepts the same actions with the session's token and this site's Origin", async () => {
    const s = await signedInWithTwoAccounts("web-csrf-ok");
    const token = await grantLink(s.userId, s.client.clientId);
    for (const [path, fields] of actions(s, token)) {
      const res = await post(s.browser, path, [["csrf", s.csrf], ...fields]);
      expect([path, res.status === 302 || res.status === 303]).toEqual([path, true]);
    }
  });
});

describe("/connections ownership", () => {
  it("refuses with 403 to act on another user's account or client, changing nothing for either user", async () => {
    const mine = await signedInWithTwoAccounts("web-idor-mine");
    const theirs = await signedInWithTwoAccounts("web-idor-theirs");
    const before = [await snapshot(mine.userId), await snapshot(theirs.userId)];
    const attempts: Array<[string, Array<[string, string]>, number]> = [
      ["/connections/disconnect", [["account", theirs.c.id]], 403],
      ["/connections/set-default", [["account", theirs.c.id]], 403],
      ["/connections/alias", [["account", theirs.c.id], ["alias", "stolen"]], 403],
      ["/connections/connect", [["service", "drive"], ["account", theirs.a.id]], 403],
      ["/connections/client-grant", [["client", mine.client.clientId], ["account", theirs.c.id]], 403],
      ["/connections/client-grant", [["client", theirs.client.clientId], ["account", mine.c.id]], 403],
      ["/connections/client-ungrant", [["client", theirs.client.clientId], ["account", theirs.a.id]], 403],
      ["/connections/client-revoke", [["client", theirs.client.clientId]], 403],
      ["/connections/confirm-grant", [["t", await grantLink(theirs.userId, theirs.client.clientId)], ["account", theirs.c.id], ["decision", "allow"]], 403],
      // Another user's link with one of my accounts: the link is not mine, so it is refused as invalid.
      ["/connections/confirm-grant", [["t", await grantLink(theirs.userId, theirs.client.clientId)], ["account", mine.c.id], ["decision", "allow"]], 400],
    ];
    for (const [path, fields, status] of attempts) {
      const res = await post(mine.browser, path, [["csrf", mine.csrf], ...fields]);
      expect([path, res.status]).toEqual([path, status]);
    }
    expect([await snapshot(mine.userId), await snapshot(theirs.userId)]).toEqual(before);
    expect(await mcpToolsList(theirs.client.accessToken)).toBe(200);
  });
});

describe("/connections actions", () => {
  it("revokes a client: its token stops working and its allowlist is gone", async () => {
    const s = await signedInWithTwoAccounts("web-revoke");
    expect(await helpers.unwrapToken(s.client.accessToken)).not.toBeNull();
    const res = await post(s.browser, "/connections/client-revoke", [["csrf", s.csrf], ["client", s.client.clientId]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/apps");
    expect(flashOf(await (await s.browser.fetch("/apps")).text())).toContain(`Client web-revoke`);
    expect(await helpers.unwrapToken(s.client.accessToken)).toBeNull();
    expect(await mcpToolsList(s.client.accessToken)).toBe(401);
    expect(await grantRows(s.userId, s.client.clientId)).toEqual([]);
  });

  it("grants and ungrants an account per client", async () => {
    const s = await signedInWithTwoAccounts("web-grant");
    const granted = await post(s.browser, "/connections/client-grant", [["csrf", s.csrf], ["client", s.client.clientId], ["account", s.c.id]]);
    expect(granted.headers.get("location")).toBe(`/apps/${encodeURIComponent(s.client.clientId)}`);
    expect((await grantRows(s.userId, s.client.clientId)).sort()).toEqual([s.a.id, s.c.id].sort());
    const ungranted = await post(s.browser, "/connections/client-ungrant", [["csrf", s.csrf], ["client", s.client.clientId], ["account", s.a.id]]);
    expect(ungranted.headers.get("location")).toBe(`/apps/${encodeURIComponent(s.client.clientId)}`);
    expect(await grantRows(s.userId, s.client.clientId)).toEqual([s.c.id]);
  });

  it("disconnects an account: revokes at Google, wipes it, and keeps its allowlist rows shown as needing reconnect", async () => {
    const s = await signedInWithTwoAccounts("web-disconnect");
    const second = await approveClient(s.browser, "Second client", defaultAccount);
    await post(s.browser, "/connections/client-grant", [["csrf", s.csrf], ["client", second.clientId], ["account", s.c.id]]);
    const refresh = await store.accounts.getRefreshToken(s.userId, s.c.id);
    const res = await post(s.browser, "/connections/disconnect", [["csrf", s.csrf], ["account", s.c.id]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/accounts");
    await expect(googleOAuth(env, fakeTransport).refresh(refresh)).rejects.toMatchObject({ code: "GWS_RECONNECT_REQUIRED" });
    expect(await store.accounts.get(s.userId, s.c.id)).toMatchObject({ status: "disconnected", hasRefreshToken: false, scopes: [] });
    expect((await grantRows(s.userId, second.clientId)).sort()).toEqual([s.a.id, s.c.id].sort());
    // A disconnected account cannot be granted again until it is reconnected.
    const regrant = await post(s.browser, "/connections/client-grant", [["csrf", s.csrf], ["client", s.client.clientId], ["account", s.c.id]]);
    expect(regrant.status).toBe(400);
    expect(await grantRows(s.userId, s.client.clientId)).toEqual([s.a.id]);

    // The kept row is still reported for the app that had it, as disconnected, and removable; an app never
    // allowed the account reports none.
    const model = await loadReadModel(env, s.userId);
    expect(model.allowedAccounts(second.clientId).map((a) => [a.id, a.status])).toContainEqual([s.c.id, "disconnected"]);
    expect(model.allowedAccounts(s.client.clientId).map((a) => a.id)).not.toContain(s.c.id);
    const removed = await post(s.browser, "/connections/client-ungrant", [["csrf", s.csrf], ["client", second.clientId], ["account", s.c.id]]);
    expect(removed.status).toBe(303);
    expect(await grantRows(s.userId, second.clientId)).toEqual([s.a.id]);
  });

  it("sets the default and an alias that a new session still shows", async () => {
    const s = await signedInWithTwoAccounts("web-settings");
    const defaulted = await post(s.browser, "/connections/set-default", [["csrf", s.csrf], ["account", s.c.id]]);
    expect(defaulted.headers.get("location")).toBe(`/accounts/${encodeURIComponent(s.c.id)}`);
    const renamed = await post(s.browser, "/connections/alias", [["csrf", s.csrf], ["account", s.c.id], ["alias", "Sheets"]]);
    expect(renamed.headers.get("location")).toBe(`/accounts/${encodeURIComponent(s.c.id)}`);
    const fresh = new Browser();
    await signIn(fresh, s.a.email);
    const page = await (await fresh.fetch("/accounts")).text();
    expect(page).toContain(s.c.email);
    expect(page).toContain("sheets");
    expect((await loadReadModel(env, s.userId)).account(s.c.id)).toMatchObject({ name: "sheets", isDefault: true });
    const cleared = await post(s.browser, "/connections/alias", [["csrf", s.csrf], ["account", s.c.id], ["alias", ""]]);
    expect(cleared.status).toBe(303);
    expect((await store.accounts.get(s.userId, s.c.id))?.alias).toBeUndefined();
  });

  it("starts Google consent for the chosen services, pre-selecting an existing account", async () => {
    const s = await signedInWithTwoAccounts("web-connect");
    const res = await post(s.browser, "/connections/connect", [["csrf", s.csrf], ["service", "docs"], ["service", "calendar"], ["account", s.c.id]]);
    expect(redirectsToGoogle(res)).toBe(true);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.searchParams.get("login_hint")).toBe(s.c.email);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/calendar.events"]),
    );
    const bad = await post(s.browser, "/connections/connect", [["csrf", s.csrf], ["service", "nope"]]);
    expect(bad.status).toBe(400);
    expect((await post(s.browser, "/connections/connect", [["csrf", s.csrf]])).status).toBe(400);
  });
});

describe("/connections grant confirmation guards", () => {
  it.each(["disconnected", "reconnect"] as const)("refuses to allow a %s account, adding no row and keeping the link", async (status) => {
    const s = await signedInWithTwoAccounts(`web-confirm-${status}`);
    const token = await grantLink(s.userId, s.client.clientId);
    if (status === "disconnected") await store.accounts.wipeToken(s.userId, s.c.id);
    else await store.accounts.markStatus(s.userId, s.c.id, "reconnect");
    const res = await post(s.browser, "/connections/confirm-grant", [["csrf", s.csrf], ["t", token], ["account", s.c.id], ["decision", "allow"]]);
    expect(res.status).toBe(400);
    expect(await grantRows(s.userId, s.client.clientId)).toEqual([s.a.id]);
    expect(await peekGrantRequest(env.CACHE_KV, token, s.userId)).not.toBeNull();
  });

  it("refuses a link whose client the user revoked since, adding no row", async () => {
    const s = await signedInWithTwoAccounts("web-confirm-revoked");
    const token = await grantLink(s.userId, s.client.clientId);
    expect((await post(s.browser, "/connections/client-revoke", [["csrf", s.csrf], ["client", s.client.clientId]])).status).toBe(303);
    const res = await post(s.browser, "/connections/confirm-grant", [["csrf", s.csrf], ["t", token], ["account", s.c.id], ["decision", "allow"]]);
    expect(res.status).toBe(400);
    expect(await grantRows(s.userId, s.client.clientId)).toEqual([]);
  });
});

/** The D1 approval rows of a user's client, oldest first. */
async function approvalRows(userId: string, clientId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT grant_id FROM client_approvals WHERE user_id = ? AND client_id = ? ORDER BY created_at, grant_id")
    .bind(userId, clientId)
    .all<{ grant_id: string }>();
  return results.map((r) => r.grant_id);
}

describe("/connections with a stale provider grant listing", () => {
  it("lists, confirms a grant for, and revokes a client approved moments ago", async () => {
    const email = uniqueEmail("web-stale");
    const userId = userIdFor(await seedGoogle(email));
    const browser = staleBrowser();
    await signIn(browser, email);
    const client = await approveClient(browser, "Just approved", () => []);
    expect((await staleHelpers.listUserGrants(userId)).items).toEqual([]);

    const page = await (await browser.fetch("/apps")).text();
    // Soft, so a regression shows all three symptoms: not listed, confirmation refused, revoke refused.
    expect.soft(page).toContain(`href="/apps/${encodeURIComponent(client.clientId)}"`);
    expect.soft(page).toContain("Just approved");
    expect.soft(await approvalRows(userId, client.clientId)).toHaveLength(1);
    const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(page)?.[1] ?? "";

    const [account] = await store.accounts.listForUser(userId);
    const token = await grantLink(userId, client.clientId);
    expect.soft((await browser.fetch(`/connections/confirm?t=${token}`)).status).toBe(200);
    const confirmed = await post(browser, "/connections/confirm-grant", [["csrf", csrf], ["t", token], ["account", account?.id ?? ""], ["decision", "allow"]]);
    expect.soft(confirmed.status).toBe(303);
    expect.soft(await grantRows(userId, client.clientId)).toEqual([account?.id]);

    expect(await mcpToolsList(client.accessToken)).toBe(200);
    const revoked = await post(browser, "/connections/client-revoke", [["csrf", csrf], ["client", client.clientId]]);
    expect.soft(revoked.status).toBe(303);
    expect(await helpers.unwrapToken(client.accessToken)).toBeNull();
    expect(await mcpToolsList(client.accessToken)).toBe(401);
    expect(await grantRows(userId, client.clientId)).toEqual([]);
    expect(await approvalRows(userId, client.clientId)).toEqual([]);
    expect(await (await browser.fetch("/apps")).text()).not.toContain(encodeURIComponent(client.clientId));
  });
});

describe("/connections for an account connected before Forms, Tasks and Slides existed", () => {
  const G = "https://www.googleapis.com/auth/";
  const FIVE_SERVICES = [
    `${G}gmail.readonly`,
    `${G}gmail.send`,
    `${G}drive.file`,
    `${G}calendar.events`,
    `${G}calendar.calendarlist.readonly`,
    `${G}spreadsheets`,
    `${G}documents`,
  ];

  /** A signed-in user whose account holds the five original services' scopes and one from a future preset. */
  async function oldAccountSignedIn(prefix: string) {
    const seeded = await seedUserWithAccount(env, { email: uniqueEmail(prefix), scopes: [...FIVE_SERVICES, `${G}some.future.scope`], isDefault: true });
    const browser = new Browser();
    expect((await loginCallback(browser, seeded.account.email)).status).toBe(302);
    return { ...seeded, browser, csrf: await csrfOf(browser) };
  }

  /** The connect form for one missing service of one account: the existing endpoint and its field names. */
  function serviceForm(csrf: string, accountId: string, service: string): { action: string; fields: Array<[string, string]> } {
    return { action: "/connections/connect", fields: [["csrf", csrf], ["account", accountId], ["service", service]] };
  }

  it("reports each new service as missing, and connecting one for that account adds it", async () => {
    const s = await oldAccountSignedIn("web-later");
    const missing = async () => (await loadReadModel(env, s.userId)).account(s.account.id)?.missingServices;
    expect(await missing()).toEqual(["forms", "tasks", "slides"]);

    const form = serviceForm(s.csrf, s.account.id, "forms");
    const res = await post(s.browser, form.action, form.fields);
    expect(redirectsToGoogle(res)).toBe(true);
    const google = new URL(res.headers.get("location") ?? "");
    expect(google.searchParams.get("scope")?.split(" ").sort()).toEqual(["openid", "email", `${G}forms.body`, `${G}forms.responses.readonly`].sort());
    expect(google.searchParams.get("login_hint")).toBe(s.account.email);
    expect(google.searchParams.get("include_granted_scopes")).toBe("true");

    // Consenting adds the service and keeps the earlier grant; it is no longer missing.
    expect((await s.browser.fetch(await pickAtFake(google.toString(), s.account.email))).status).toBe(302);
    expect((await store.accounts.get(s.userId, s.account.id))?.scopes).toEqual(expect.arrayContaining([...FIVE_SERVICES, `${G}forms.body`]));
    expect(await missing()).toEqual(["tasks", "slides"]);
  });

  it("refuses the per-service connect POST without the session's CSRF token or from another site, starting nothing", async () => {
    const s = await oldAccountSignedIn("web-later-csrf");
    const { action, fields } = serviceForm(s.csrf, s.account.id, "tasks");
    const noCsrf = fields.filter(([name]) => name !== "csrf");
    for (const res of [
      await post(s.browser, action, noCsrf),
      await post(s.browser, action, [["csrf", "x".repeat(43)], ...noCsrf]),
      await post(s.browser, action, fields, "https://evil.example"),
      await post(s.browser, action, fields, null),
    ]) {
      expect(res.status).toBe(403);
      expect(redirectsToGoogle(res)).toBe(false);
    }
    expect((await post(new Browser(), action, fields)).status).toBe(401);
  });

  it("refuses the per-service connect for another user's account", async () => {
    const mine = await oldAccountSignedIn("web-later-mine");
    const theirs = await oldAccountSignedIn("web-later-theirs");
    const res = await post(mine.browser, "/connections/connect", [["csrf", mine.csrf], ["account", theirs.account.id], ["service", "slides"]]);
    expect(res.status).toBe(403);
    expect(redirectsToGoogle(res)).toBe(false);
  });

  it("reports a disconnected account as disconnected, so it reconnects as a whole", async () => {
    const s = await oldAccountSignedIn("web-later-disc");
    await store.accounts.wipeToken(s.userId, s.account.id);
    expect((await loadReadModel(env, s.userId)).account(s.account.id)).toMatchObject({ status: "disconnected", services: [] });
  });
});

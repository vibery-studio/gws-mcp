import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth/session";
import { openStore } from "../../src/store/db";
import { webApp } from "../../src/web/app";
import { GUARDED_POST_PATHS } from "../../src/web/connections";
import { COPY } from "../../src/web/copy";
import { loadReadModel } from "../../src/web/read-model";
import { PAGE_CSP, STYLESHEET } from "../../src/web/ui";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, approveClient, config, defaultAccount, pickAtFake, redirectsToGoogle, seedGoogle, signIn, userIdFor } from "../auth/browser";
import { expectPlainLanguage } from "./plain-language";

const store = openStore(env);
const G = "https://www.googleapis.com/auth/";

function post(browser: Browser, path: string, fields: Array<[string, string]>, origin: string | null = BASE): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The CSRF token of the shell's sign-out form on a signed-in page. */
async function csrfOf(browser: Browser): Promise<string> {
  const m = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/accounts")).text());
  if (!m?.[1]) throw new Error("page has no csrf field");
  return m[1];
}

/** A signed-in user with one account (primary, default) and one approved app allowed it. */
async function signedIn(prefix: string) {
  const email = uniqueEmail(`${prefix}-a`);
  const sub = await seedGoogle(email);
  const browser = new Browser();
  await signIn(browser, email);
  const userId = userIdFor(sub);
  const [account] = await store.accounts.listForUser(userId);
  if (!account) throw new Error("setup account missing");
  const app = await approveClient(browser, `Helper ${prefix}`, defaultAccount);
  return { browser, userId, email, account, app, csrf: await csrfOf(browser) };
}

type Setup = Awaited<ReturnType<typeof signedIn>>;

/** Every signed-in page with the navigation area it belongs to. */
function pages(s: Setup): Array<[string, "home" | "accounts" | "apps"]> {
  const a = encodeURIComponent(s.account.id);
  const app = encodeURIComponent(s.app.clientId);
  return [
    ["/", "home"],
    ["/accounts", "accounts"],
    [`/accounts/${a}`, "accounts"],
    [`/accounts/${a}/services`, "accounts"],
    [`/accounts/${a}/reconnect`, "accounts"],
    [`/accounts/${a}/disconnect`, "accounts"],
    ["/apps", "apps"],
    [`/apps/${app}`, "apps"],
    [`/apps/${app}/remove`, "apps"],
  ];
}

/** The new POST endpoints, with the account or app they act on. */
function newPosts(s: Setup): string[] {
  const a = encodeURIComponent(s.account.id);
  return [`/accounts/${a}/name`, `/accounts/${a}/services`, `/apps/${encodeURIComponent(s.app.clientId)}/access`];
}

describe("page skeleton", () => {
  it("serves every page to its signed-in user in the shared shell, with the area marked and in plain words", async () => {
    const s = await signedIn("skel-pages");
    for (const [path, area] of pages(s)) {
      const res = await s.browser.fetch(path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      const page = await res.text();
      expect(page).toContain(`<style>${STYLESHEET}</style>`);
      expect(page).not.toMatch(/<script/i);
      const href = area === "home" ? "/" : `/${area}`;
      expect([path, /<a href="([^"]+)" aria-current="page">/.exec(page)?.[1]]).toEqual([path, href]);
      expect(page).toContain(`<span class="mono">${s.email}</span>`);
      expectPlainLanguage(page, { connectorUrl: config.mcpResource });
    }
  });

  it("sends a signed-out browser to sign in, coming back to the page; Home shows the sign-in screen", async () => {
    const s = await signedIn("skel-out");
    for (const [path] of pages(s).filter(([p]) => p !== "/")) {
      const res = await new Browser().fetch(path);
      expect([path, res.status, res.headers.get("location")]).toEqual([path, 302, `/login?next=${encodeURIComponent(path)}`]);
    }
    const home = await new Browser().fetch("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toBe(PAGE_CSP);
    const page = await home.text();
    expect(page).toContain('href="/login"');
    expect(page).toContain(COPY.actions.continueWithGoogle);
    expect(page).not.toContain('<nav class="nav"');
    expectPlainLanguage(page);
  });

  it("answers 404 for another user's or an unknown account or app, showing nothing of it", async () => {
    const mine = await signedIn("skel-404-mine");
    const theirs = await signedIn("skel-404-theirs");
    const foreign = pages(theirs).filter(([p]) => p.split("/").length > 2);
    const unknown = pages(theirs)
      .filter(([p]) => p.split("/").length > 2)
      .map(([p]): [string, string] => [p.replace(encodeURIComponent(theirs.account.id), "a_nope").replace(encodeURIComponent(theirs.app.clientId), "nope"), ""]);
    for (const [path] of [...foreign, ...unknown, [`/accounts/${"x".repeat(300)}`, ""] as const]) {
      const res = await mine.browser.fetch(path);
      expect([path, res.status]).toEqual([path, 404]);
      const page = await res.text();
      expect(page).not.toContain(theirs.email);
      expect(page).not.toContain(`Helper skel-404-theirs`);
    }
  });

  it("redirects /connections to Google accounts with 303, dropping any query", async () => {
    const s = await signedIn("skel-conn");
    for (const browser of [s.browser, new Browser()]) {
      const res = await browser.fetch(`/connections?connected=${encodeURIComponent("<b>x</b>")}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/accounts");
    }
  });
});

describe("POST protection on the new endpoints", () => {
  it("covers every POST route: each sits under a guarded path or checks its own CSRF token", () => {
    const own = new Set(["/authorize", "/logout"]);
    const guarded = (path: string) => GUARDED_POST_PATHS.some((g) => (g.endsWith("/*") ? path.startsWith(g.slice(0, -1)) || path === g.slice(0, -2) : path === g));
    const posts = webApp.routes.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toEqual(expect.arrayContaining(["/accounts/:id/name", "/accounts/:id/services", "/apps/:id/access"]));
    expect(posts.filter((p) => !own.has(p) && !guarded(p))).toEqual([]);
  });

  const attempts: Array<[string, (csrf: string) => { csrf?: string; origin: string | null }]> = [
    ["no CSRF token", () => ({ origin: BASE })],
    ["a wrong CSRF token", () => ({ csrf: "x".repeat(43), origin: BASE })],
    ["another site's Origin", (csrf) => ({ csrf, origin: "https://evil.example" })],
    ["an opaque null Origin", (csrf) => ({ csrf, origin: "null" })],
    ["no Origin", (csrf) => ({ csrf, origin: null })],
  ];

  it.each(attempts)("refuses each new POST with %s, changing nothing", async (_label, attempt) => {
    const s = await signedIn("skel-guard");
    const before = { accounts: await store.accounts.listForUser(s.userId), grants: await store.grants.list(s.userId, s.app.clientId) };
    const { csrf, origin } = attempt(s.csrf);
    for (const path of newPosts(s)) {
      const res = await post(s.browser, path, [...(csrf === undefined ? [] : [["csrf", csrf] as [string, string]]), ["alias", "x"], ["service", "drive"]], origin);
      expect([path, res.status]).toEqual([path, 403]);
      expect(redirectsToGoogle(res)).toBe(false);
    }
    expect({ accounts: await store.accounts.listForUser(s.userId), grants: await store.grants.list(s.userId, s.app.clientId) }).toEqual(before);
  });

  it("refuses each new POST without a session with 401", async () => {
    const s = await signedIn("skel-guard-anon");
    for (const path of newPosts(s)) {
      const res = await post(new Browser(), path, [["csrf", s.csrf]]);
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it("lets each new POST through the checks with the session's token and this site's Origin", async () => {
    const s = await signedIn("skel-guard-ok");
    for (const path of newPosts(s)) {
      const res = await post(s.browser, path, [["csrf", s.csrf]]);
      expect([path, [401, 403, 404].includes(res.status)]).toEqual([path, false]);
      await res.body?.cancel();
    }
  });
});

/** The stored flash record behind the browser's flash cookie, without using it up. */
async function storedFlash(browser: Browser): Promise<unknown> {
  const ref = browser.cookies.get("__Host-gws_flash");
  if (!ref) return null;
  return JSON.parse((await env.CACHE_KV.get(`flash:${await sha256Hex(ref)}`)) ?? "null");
}

describe("connect completion", () => {
  async function connect(s: Setup, email: string, account?: string): Promise<Response> {
    const start = await post(s.browser, "/connections/connect", [["csrf", s.csrf], ["service", "sheets"], ...(account ? [["account", account] as [string, string]] : [])]);
    expect(redirectsToGoogle(start)).toBe(true);
    return s.browser.fetch(await pickAtFake(start.headers.get("location") ?? "", email));
  }

  it("returns to Google accounts with a one-time flash naming the new account, and nothing about it in the URL", async () => {
    const s = await signedIn("skel-flash");
    const emailC = uniqueEmail("skel-flash-c");
    await seedGoogle(emailC);
    const done = await connect(s, emailC);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/accounts");
    const c = (await store.accounts.listForUser(s.userId)).find((a) => a.email === emailC);
    expect(await storedFlash(s.browser)).toEqual({ userId: s.userId, flash: { tone: "success", kind: "account-connected", accountId: c?.id, isNew: true } });

    const page = await (await s.browser.fetch("/accounts")).text();
    const banner = /<div class="flash flash-success" role="status">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? "";
    expect(banner).toContain(emailC);
    expect(await (await s.browser.fetch("/accounts")).text()).not.toContain('class="flash');
  });

  it("marks a reconnect of an existing account as not new", async () => {
    const s = await signedIn("skel-flash-again");
    const done = await connect(s, s.email, s.account.id);
    expect(done.headers.get("location")).toBe("/accounts");
    expect(await storedFlash(s.browser)).toMatchObject({ flash: { kind: "account-connected", accountId: s.account.id, isNew: false } });
  });
});

describe("read model", () => {
  it("joins accounts and approved apps both ways, for one user only", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("rm-a"), scopes: [`${G}gmail.readonly`, `${G}gmail.send`, `${G}drive.file`] });
    const c = await seedUserWithAccount(env, { email: uniqueEmail("rm-c"), scopes: [`${G}tasks`], userId: a.userId, alias: "work" });
    const other = await seedUserWithAccount(env, { email: uniqueEmail("rm-other"), scopes: [`${G}tasks`] });
    const app = (name: string) => ({ id: `client-${crypto.randomUUID()}`, name });
    const [zed, alpha, theirs, orphan] = [app("Zed app"), app("Alpha app"), app("Their app"), app("Orphan")];
    for (const [userId, x] of [[a.userId, zed], [a.userId, alpha], [other.userId, theirs]] as const) {
      await store.approvals.record({ userId, clientId: x.id, grantId: crypto.randomUUID().replace(/-/g, ""), clientName: x.name });
    }
    await store.grants.replace(a.userId, zed.id, [a.account.id, c.account.id]);
    await store.grants.replace(a.userId, alpha.id, [a.account.id]);
    await store.grants.replace(a.userId, orphan.id, [c.account.id]);
    await store.grants.replace(other.userId, theirs.id, [other.account.id]);
    await store.accounts.wipeToken(a.userId, c.account.id);

    const m = await loadReadModel(env, a.userId);
    expect(m.signedInEmail).toBe(a.account.email);
    expect(m.apps.map((x) => x.name)).toEqual(["Alpha app", "Zed app"]);
    expect(m.allowedFor(a.account.id)).toEqual([alpha, zed]);
    expect(m.allowedFor(c.account.id)).toEqual([zed]);
    expect(m.allowedAccounts(zed.id).map((x) => [x.id, x.status])).toEqual(
      [[a.account.id, "active"], [c.account.id, "disconnected"]].sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? "")),
    );
    expect(m.app(orphan.id)).toBeUndefined();
    expect(m.app(theirs.id)).toBeUndefined();
    expect(m.account(other.account.id)).toBeUndefined();
    expect(m.allowedAccounts(theirs.id)).toEqual([]);
    expect(m.account(a.account.id)).toMatchObject({ name: a.account.email, isPrimary: true, isDefault: true, services: ["gmail", "drive"] });
    expect(m.account(a.account.id)?.missingServices).toEqual(["calendar", "sheets", "docs", "forms", "tasks", "slides"]);
    expect(m.account(c.account.id)).toMatchObject({ name: "work", alias: "work", isPrimary: false, services: [], status: "disconnected" });
  });
});

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetAccessCache } from "../../src/auth/access";
import { providerOptions } from "../../src/auth/provider-options";
import { mcpApiHandler } from "../../src/mcp/server";
import { webApp } from "../../src/web/app";
import { openAccessStore } from "../../src/store/access";
import { ACCESS_COPY } from "../../src/web/access-copy";
import { PAGE_CSP } from "../../src/web/ui";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, approveClient, defaultAccount, seedGoogle, signIn, userIdFor } from "../auth/browser";
import { expectPlainLanguage } from "./plain-language";

/** The admin-only "Who can use this" area at /access and its two forms. */

const access = openAccessStore(env.DB);
const SETUP = { actor: "u_test", via: "web" as const };

function post(browser: Browser, path: string, fields: Array<[string, string]>, origin: string | null = BASE): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams(fields).toString(),
  });
}

async function csrfOf(browser: Browser): Promise<string> {
  const m = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/accounts")).text());
  if (!m?.[1]) throw new Error("page has no csrf field");
  return m[1];
}

/** A signed-in user; an admin through an exact admin rule (the setup's @fake.test rule makes everyone else a user). */
async function person(prefix: string, role: "admin" | "user") {
  const email = uniqueEmail(prefix);
  if (role === "admin") await access.add({ pattern: email, role: "admin" }, SETUP);
  const sub = await seedGoogle(email);
  const browser = new Browser();
  await signIn(browser, email);
  return { browser, email, userId: userIdFor(sub), csrf: await csrfOf(browser) };
}

/** Page text as hono/html escapes it. */
const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function auditCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM access_audit").first<{ n: number }>())?.n ?? 0;
}

beforeEach(() => forgetAccessCache());

describe("/access for an admin", () => {
  it("shows the list in the shared shell, in plain words, with the nav item", async () => {
    const admin = await person("acc-admin", "admin");
    await access.add({ pattern: "@listed-domain.test", role: "user", note: "the <b>team</b>" }, SETUP);
    const res = await admin.browser.fetch("/access");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await res.text();
    expect(page).toContain(`<a href="/access" aria-current="page">${ACCESS_COPY.nav}</a>`);
    expect(page).toContain("@listed-domain.test");
    expect(page).toContain("the &lt;b&gt;team&lt;/b&gt;");
    expectPlainLanguage(page, { allow: [admin.email, "the <b>team</b>"] });
    // Every signed-in page shows the item to an admin.
    expect(await (await admin.browser.fetch("/accounts")).text()).toContain(`<a href="/access">${ACCESS_COPY.nav}</a>`);
  });

  it("adds a rule, sets its role and removes it, each with a flash and exactly one audit row", async () => {
    const admin = await person("acc-change", "admin");
    const before = await auditCount();
    const added = await post(admin.browser, "/access/add", [["csrf", admin.csrf], ["pattern", " New@Added-Web.test "], ["role", "user"], ["note", "contractor"]]);
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe("/access");
    expect(await access.get("new@added-web.test")).toMatchObject({ role: "user", note: "contractor", createdBy: admin.userId });
    const shown = await (await admin.browser.fetch("/access")).text();
    expect(shown).toContain(escaped(ACCESS_COPY.saved));

    await post(admin.browser, "/access/add", [["csrf", admin.csrf], ["pattern", "new@added-web.test"], ["role", "admin"]]);
    expect(await access.get("new@added-web.test")).toMatchObject({ role: "admin" });

    const removed = await post(admin.browser, "/access/remove", [["csrf", admin.csrf], ["pattern", "new@added-web.test"]]);
    expect(removed.status).toBe(303);
    expect(await access.get("new@added-web.test")).toBeNull();
    expect(await (await admin.browser.fetch("/access")).text()).toContain(escaped(ACCESS_COPY.removed));

    const rows = await env.DB.prepare("SELECT actor, via, action FROM access_audit ORDER BY ts, rowid").all();
    expect(rows.results.slice(before)).toEqual([
      { actor: admin.userId, via: "web", action: "add" },
      { actor: admin.userId, via: "web", action: "role" },
      { actor: admin.userId, via: "web", action: "remove" },
    ]);
  });

  it("words a refused change in the flash: a malformed pattern, the last admin", async () => {
    const admin = await person("acc-refuse", "admin");
    await post(admin.browser, "/access/add", [["csrf", admin.csrf], ["pattern", "not an email"], ["role", "user"]]);
    expect(await (await admin.browser.fetch("/access")).text()).toContain(escaped(ACCESS_COPY.badPattern));

    // Make this admin the only one, then try to remove it.
    await env.DB.prepare("DELETE FROM access_rules WHERE role = 'admin' AND pattern <> ?").bind(admin.email).run();
    forgetAccessCache();
    await post(admin.browser, "/access/remove", [["csrf", admin.csrf], ["pattern", admin.email]]);
    expect(await (await admin.browser.fetch("/access")).text()).toContain(escaped(ACCESS_COPY.lastAdmin));
    expect(await access.get(admin.email)).toMatchObject({ role: "admin" });
  });

  it("removing someone ends their session and their AI apps' access at once", async () => {
    const admin = await person("acc-revoker", "admin");
    const email = `gone-${crypto.randomUUID().slice(0, 8)}@removed-web.test`;
    await access.add({ pattern: email, role: "user" }, SETUP);
    const sub = await seedGoogle(email);
    const target = new Browser();
    await signIn(target, email);
    const app = await approveClient(target, "Removed Helper", defaultAccount);
    expect((await target.fetch("/apps")).status).toBe(200);

    await post(admin.browser, "/access/remove", [["csrf", admin.csrf], ["pattern", email]]);
    const approvals = await env.DB.prepare("SELECT COUNT(*) AS n FROM client_approvals WHERE user_id = ?").bind(userIdFor(sub)).first<{ n: number }>();
    expect(approvals?.n).toBe(0);
    expect(app.clientId).toBeTruthy();
    // Same isolate: the removal cleared the cache, so the session is gone now.
    expect((await target.fetch("/apps")).status).toBe(302);
  });
  it("says plainly when the cleanup of a removed person's AI apps did not finish, and their app stays cut off", async () => {
    const admin = await person("acc-partial", "admin");
    const email = `partial-${crypto.randomUUID().slice(0, 8)}@removed-web.test`;
    await access.add({ pattern: email, role: "user" }, SETUP);
    const sub = await seedGoogle(email);
    const target = new Browser();
    await signIn(target, email);
    await approveClient(target, "Partly Removed Helper", defaultAccount);

    // The provider's grant listing and revokes fail; only this request's web app sees that provider.
    const providerConfig = { ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp };
    const failing = new Proxy(getOAuthApi(providerConfig, env), {
      get(t, key) {
        if (key === "listUserGrants" || key === "revokeGrant") return () => Promise.reject(new Error("KV unavailable"));
        const value: unknown = Reflect.get(t, key, t);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
      },
    });
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const viaFailing = new Browser((r) => Promise.resolve(webApp.fetch(r, { ...env, OAUTH_PROVIDER: failing }, ctx)));
    for (const [k, v] of admin.browser.cookies) viaFailing.cookies.set(k, v);
    const res = await post(viaFailing, "/access/remove", [["csrf", admin.csrf], ["pattern", email]]);
    expect(res.status).toBe(303);
    for (const [k, v] of viaFailing.cookies) admin.browser.cookies.set(k, v);
    const page = await (await admin.browser.fetch("/access")).text();
    expect(page).toContain(escaped(ACCESS_COPY.removedPartly));
    expect(page).not.toContain(escaped(ACCESS_COPY.removed));
    expect(page).toContain('class="flash flash-warning"');
    const approvals = await env.DB.prepare("SELECT COUNT(*) AS n FROM client_approvals WHERE user_id = ?").bind(userIdFor(sub)).first<{ n: number }>();
    expect(approvals?.n).toBe(0);
  });
});

describe("/access for anyone else", () => {
  it("answers 404 to a non-admin, shows no nav item, and refuses a crafted POST that carries a valid CSRF token", async () => {
    const user = await person("acc-user", "user");
    expect((await user.browser.fetch("/access")).status).toBe(404);
    expect(await (await user.browser.fetch("/accounts")).text()).not.toContain(ACCESS_COPY.nav);
    const before = await auditCount();
    const add = await post(user.browser, "/access/add", [["csrf", user.csrf], ["pattern", "@takeover.test"], ["role", "admin"]]);
    expect(add.status).toBe(404);
    const remove = await post(user.browser, "/access/remove", [["csrf", user.csrf], ["pattern", "@fake.test"]]);
    expect(remove.status).toBe(404);
    expect(await access.get("@takeover.test")).toBeNull();
    expect(await access.get("@fake.test")).not.toBeNull();
    expect(await auditCount()).toBe(before);
  });

  it("re-reads the role on each request: a demoted admin loses the page at once in this isolate", async () => {
    const admin = await person("acc-demoted", "admin");
    expect((await admin.browser.fetch("/access")).status).toBe(200);
    // Demoted directly in the database, the cache untouched: the page reads the role fresh.
    await env.DB.prepare("UPDATE access_rules SET role = 'user' WHERE pattern = ?").bind(admin.email).run();
    expect((await admin.browser.fetch("/access")).status).toBe(404);
    const r = await post(admin.browser, "/access/add", [["csrf", admin.csrf], ["pattern", "@late.test"], ["role", "user"]]);
    expect(r.status).toBe(404);
    expect(await access.get("@late.test")).toBeNull();
  });

  it("sends a signed-out browser to sign in", async () => {
    const res = await new Browser().fetch("/access");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Faccess");
  });

  it("puts both forms behind the session, Origin and CSRF checks", async () => {
    const admin = await person("acc-guard", "admin");
    const before = await auditCount();
    for (const path of ["/access/add", "/access/remove"]) {
      const fields: Array<[string, string]> = [["pattern", "@guarded.test"], ["role", "user"]];
      expect((await post(new Browser(), path, [["csrf", admin.csrf], ...fields])).status).toBe(401);
      expect((await post(admin.browser, path, [["csrf", admin.csrf], ...fields], null)).status).toBe(403);
      expect((await post(admin.browser, path, [["csrf", admin.csrf], ...fields], "https://evil.example")).status).toBe(403);
      expect((await post(admin.browser, path, [["csrf", "A".repeat(43)], ...fields])).status).toBe(403);
      expect((await post(admin.browser, path, fields)).status).toBe(403);
    }
    expect(await access.get("@guarded.test")).toBeNull();
    expect(await auditCount()).toBe(before);
  });
});

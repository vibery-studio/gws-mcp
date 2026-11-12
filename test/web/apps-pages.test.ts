import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { providerOptions } from "../../src/auth/provider-options";
import { mcpApiHandler } from "../../src/mcp/server";
import { openStore } from "../../src/store/db";
import { webApp } from "../../src/web/app";
import { renderConfirmGrantPage, type PageAccount } from "../../src/web/connections-page";
import { COPY, SERVICE_NAMES } from "../../src/web/copy";
import { appsFlash } from "../../src/web/pages/apps";
import { loadReadModel } from "../../src/web/read-model";
import { PAGE_CSP } from "../../src/web/ui";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, approveClient, config, defaultAccount, grantRows, mcpToolsList, seedGoogle, signIn, userIdFor } from "../auth/browser";
import { expectPlainLanguage, helpBlockTexts } from "./plain-language";

const store = openStore(env);
const helpers = getOAuthApi({ ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp }, env);
const G = "https://www.googleapis.com/auth/";
const HOSTILE = `<img src=x onerror=alert(1)> & "Co"`;
const HOSTILE_ESCAPED = "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;";

/** `text` as the pages render it (HTML-escaped). */
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function post(browser: Browser, path: string, fields: Array<[string, string]>, origin: string | null = BASE): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The first hidden CSRF field of a signed-in page (the shell's sign-out form). */
async function csrfOf(browser: Browser): Promise<string> {
  const m = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/apps")).text());
  if (!m?.[1]) throw new Error("page has no csrf field");
  return m[1];
}

function flashOf(page: string): { tone: string; text: string } | undefined {
  const m = /<div class="flash flash-([a-z]+)" role="(?:status|alert)">([\s\S]*?)<\/div>/.exec(page);
  return m ? { tone: m[1] ?? "", text: m[2] ?? "" } : undefined;
}

const appPath = (id: string) => `/apps/${encodeURIComponent(id)}`;

/**
 * A signed-in user with A (primary, default, from sign-in) and B (connected, alias "work"), and one approved
 * AI app allowed A only.
 */
async function signedIn(prefix: string, appName = `Helper ${prefix}`) {
  const emailA = uniqueEmail(`${prefix}-a`);
  const browser = new Browser();
  const userId = userIdFor(await seedGoogle(emailA));
  await signIn(browser, emailA);
  const [a] = await store.accounts.listForUser(userId);
  if (!a) throw new Error("setup account missing");
  const b = (await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-b`), scopes: [`${G}drive.file`, `${G}tasks`], userId, alias: "work" })).account;
  const app = await approveClient(browser, appName, defaultAccount);
  return { browser, userId, a, b, app, appName, csrf: await csrfOf(browser) };
}

type Setup = Awaited<ReturnType<typeof signedIn>>;

/** Everything an AI-app action could change for `userId`: accounts, allowlist rows and provider grants. */
async function snapshot(userId: string) {
  const accounts = await store.accounts.listForUser(userId);
  const { results: grants } = await env.DB.prepare("SELECT client_id, account_id FROM client_grants WHERE user_id = ? ORDER BY client_id, account_id")
    .bind(userId)
    .all();
  const { results: approvals } = await env.DB.prepare("SELECT client_id, grant_id FROM client_approvals WHERE user_id = ? ORDER BY client_id, grant_id")
    .bind(userId)
    .all();
  const { items } = await helpers.listUserGrants(userId);
  return { accounts, grants, approvals, oauthGrants: items.map((g) => g.id).sort() };
}

/** The allowlist an /apps/:id form carries: the accounts it showed as allowed. */
function shownField(page: string): string | undefined {
  const m = /<input type="hidden" name="shown" value="([^"]*)">/.exec(page);
  return m?.[1];
}

/** Posts the app's access form as a page showing `shownIds` would (by default, the allowlist as it is now). */
async function saveAccess(
  s: Setup,
  accountIds: readonly string[],
  appId = s.app.clientId,
  origin: string | null = BASE,
  shownIds?: readonly string[],
): Promise<Response> {
  const showing = shownIds ?? (await grantRows(s.userId, appId));
  return post(
    s.browser,
    `${appPath(appId)}/access`,
    [["csrf", s.csrf], ["shown", showing.join(" ")], ...accountIds.map((id): [string, string] => ["account", id])],
    origin,
  );
}

/** The user values a page of this setup shows, for the plain-language check. */
const shown = (s: Setup) => [s.a.email, s.b.email, "work", s.appName];

describe("/apps", () => {
  it("lists each approved AI app with its escaped name, its allowed accounts as chips and a way to manage it", async () => {
    const s = await signedIn("apps-list", HOSTILE);
    const res = await s.browser.fetch("/apps");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const page = await res.text();
    expect(page).not.toContain("<img");
    expect(page).toContain(HOSTILE_ESCAPED);
    expect(page).toContain(`href="${appPath(s.app.clientId)}"`);
    expect(page).toContain(COPY.chips.approved);
    expect(page).toContain(COPY.actions.manageAccess);
    expect(page).toContain(`<span class="chip">${s.a.email}</span>`);
    expect(page).not.toContain(`<span class="chip">work</span>`);
    expect(page).toContain("Allowed to use 1 of your 2 Google accounts.");
    expect(page).toContain("can't confirm who made them");
    // Apps connect from their side: no button pretends to connect one from here, and no help block once one has.
    expect(page).not.toMatch(/Connect (an )?AI app<\/(a|button)>/);
    expect(helpBlockTexts(page)).toEqual([]);
    expect(page).toMatch(/<form method="post" action="\/logout"[^>]*>\s*<input type="hidden" name="csrf" value="[^"]+">/);
    expectPlainLanguage(page, { allow: shown(s) });
  });

  it("shows an app allowed no account as such, and an allowed account that needs reconnecting with its status", async () => {
    const s = await signedIn("apps-states");
    const none = await approveClient(s.browser, "Nothing allowed", () => []);
    await store.grants.add(s.userId, s.app.clientId, s.b.id);
    await store.accounts.markStatus(s.userId, s.b.id, "reconnect");
    const page = await (await s.browser.fetch("/apps")).text();
    expect(page).toContain(`href="${appPath(none.clientId)}"`);
    expect(page).toContain("Not allowed to use any of your Google accounts.");
    expect(page).toContain(`<span class="chip chip-warn">work: ${COPY.status.reconnect}</span>`);
    expectPlainLanguage(page, { allow: [...shown(s), "Nothing allowed"] });
  });

  it("explains how an AI app connects when none is approved yet, in the one marked help block", async () => {
    const email = uniqueEmail("apps-empty");
    const browser = new Browser();
    await seedGoogle(email);
    await signIn(browser, email);
    const page = await (await browser.fetch("/apps")).text();
    expect(page).toContain(esc(COPY.empty.noApps));
    expect(helpBlockTexts(page)).toHaveLength(1);
    expect(page).toContain(config.mcpResource);
    expect(page).not.toMatch(/Connect (an )?AI app<\/(a|button)>/);
    expectPlainLanguage(page, { allow: [email], connectorUrl: config.mcpResource });
  });

  it("confirms a removal by the app's name, and a declined request without claiming a change", async () => {
    const s = await signedIn("apps-flash", "Flash app");
    const removed = await post(s.browser, "/connections/client-revoke", [["csrf", s.csrf], ["client", s.app.clientId]]);
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/apps");
    const page = await (await s.browser.fetch("/apps")).text();
    expect(flashOf(page)).toEqual({ tone: "success", text: "<p>Flash app&#39;s access was removed.</p>" });
    expect(page).not.toContain(encodeURIComponent(s.app.clientId));

    const other = await approveClient(s.browser, "Declined app", () => []);
    const model = await loadReadModel(env, s.userId);
    expect(appsFlash({ tone: "success", kind: "app-request-declined", appId: other.clientId }, model)).toEqual({
      tone: "success",
      text: "Nothing changed. Declined app was not allowed another account.",
    });
    expect(appsFlash({ tone: "success", kind: "app-request-declined", appId: s.app.clientId }, model).text).toBe(
      "Nothing changed. The AI app was not allowed another account.",
    );
  });
});

describe("/apps/:id", () => {
  it("offers a checkbox per account with its status, checked only where allowed, in a protected form", async () => {
    const s = await signedIn("app-details", HOSTILE);
    const res = await s.browser.fetch(appPath(s.app.clientId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    const page = await res.text();
    expect(page).not.toContain("<img");
    expect(page).toContain(`<h1 class="title"><bdi>${HOSTILE_ESCAPED}</bdi></h1>`);
    expect(page).toContain(
      `<form method="post" action="${appPath(s.app.clientId)}/access"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="shown" value="${s.a.id}">`,
    );
    expect(page).toContain(`<input type="checkbox" name="account" value="${s.a.id}" checked>`);
    expect(page).toContain(`<input type="checkbox" name="account" value="${s.b.id}">`);
    expect(page.match(/<input type="checkbox"/g)).toHaveLength(2);
    expect(page.match(new RegExp(COPY.status.active, "g"))?.length).toBeGreaterThanOrEqual(2);
    expect(page).toContain(SERVICE_NAMES.drive);
    expect(page).toContain(`>${COPY.actions.saveChanges}</button>`);
    expect(page).toContain(`href="${appPath(s.app.clientId)}/remove"`);
    expect(page).toContain(COPY.actions.removeAiApp);
    expect(page).toContain(esc(COPY.trust.writeGuard));
    expect(page).toContain(esc(COPY.trust.defaultIsNotAccess));
    expect(page).toContain(esc(COPY.trust.appNameNotVerified));
    expectPlainLanguage(page, { allow: shown(s) });
  });

  it("disables allowing an account that is not connected, and keeps showing a disconnected one only while allowed", async () => {
    const s = await signedIn("app-details-states");
    const gone = (await seedUserWithAccount(env, { email: uniqueEmail("app-details-gone"), scopes: [`${G}tasks`], userId: s.userId })).account;
    const kept = (await seedUserWithAccount(env, { email: uniqueEmail("app-details-kept"), scopes: [`${G}tasks`], userId: s.userId })).account;
    await store.grants.add(s.userId, s.app.clientId, kept.id);
    await store.accounts.wipeToken(s.userId, gone.id);
    await store.accounts.wipeToken(s.userId, kept.id);
    await store.accounts.markStatus(s.userId, s.b.id, "reconnect");
    const page = await (await s.browser.fetch(appPath(s.app.clientId))).text();
    expect(page).toContain(`<input type="checkbox" value="${s.b.id}" disabled>`);
    expect(page).not.toContain(`name="account" value="${s.b.id}"`);
    expect(page).not.toContain(gone.email);
    expect(page).toContain(`<input type="checkbox" name="account" value="${kept.id}" checked>`);
    expect(page).toContain(COPY.status.disconnected);
    expect(page).toContain(COPY.status.reconnect);
    expectPlainLanguage(page, { allow: [...shown(s), kept.email] });
  });

  it("explains that the default account is refused when the app isn't allowed it", async () => {
    const s = await signedIn("app-details-default");
    const without = await (await s.browser.fetch(appPath(s.app.clientId))).text();
    expect(without).not.toContain("it never switches to another account");
    await store.accounts.setDefault(s.userId, s.b.id);
    const page = await (await s.browser.fetch(appPath(s.app.clientId))).text();
    expect(page).toContain(
      esc("Your AI uses the default account when it doesn't name one, but only if that AI app is allowed to use it. Otherwise the request is refused; it never switches to another account."),
    );
  });

  it("saves the allowed set in one POST: adds and removes exactly the difference, then shows the result", async () => {
    const s = await signedIn("app-save");
    const res = await saveAccess(s, [s.b.id]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(appPath(s.app.clientId));
    expect(await grantRows(s.userId, s.app.clientId)).toEqual([s.b.id]);
    const page = await (await s.browser.fetch(appPath(s.app.clientId))).text();
    expect(flashOf(page)).toEqual({ tone: "success", text: `<p>Saved. Helper app-save is allowed to use work.</p>` });
    expect(page).toContain(`<input type="checkbox" name="account" value="${s.b.id}" checked>`);
    expect(page).toContain(`<input type="checkbox" name="account" value="${s.a.id}">`);
    // The same set again changes nothing.
    const before = await snapshot(s.userId);
    expect((await saveAccess(s, [s.b.id, s.b.id])).status).toBe(303);
    expect(await snapshot(s.userId)).toEqual(before);
  });

  it("saves zero accounts: the app stays approved and connected but can use no account", async () => {
    const s = await signedIn("app-save-none");
    const res = await saveAccess(s, []);
    expect(res.status).toBe(303);
    expect(await grantRows(s.userId, s.app.clientId)).toEqual([]);
    expect(await mcpToolsList(s.app.accessToken)).toBe(200);
    const page = await (await s.browser.fetch(appPath(s.app.clientId))).text();
    expect(flashOf(page)).toEqual({ tone: "warning", text: `<p>Saved. ${esc(COPY.trust.appStaysApprovedWithoutAccounts("Helper app-save-none"))}</p>` });
    expect(page).toContain(esc(COPY.trust.appStaysApprovedWithoutAccounts("Helper app-save-none")));
    const list = await (await s.browser.fetch("/apps")).text();
    expect(list).toContain(`href="${appPath(s.app.clientId)}"`);
  });

  it("refuses to newly allow an account that is not connected, keeping the user's choices, and changes nothing", async () => {
    const s = await signedIn("app-save-stale");
    const kept = (await seedUserWithAccount(env, { email: uniqueEmail("app-save-kept"), scopes: [`${G}tasks`], userId: s.userId })).account;
    await store.grants.add(s.userId, s.app.clientId, kept.id);
    await store.accounts.wipeToken(s.userId, kept.id);
    await store.accounts.markStatus(s.userId, s.b.id, "reconnect");
    const before = await snapshot(s.userId);
    const res = await saveAccess(s, [s.b.id]);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    const page = await res.text();
    expect(page).toContain("Only connected accounts can be newly allowed. Reconnect work first.");
    expect(page).not.toContain(`value="${s.a.id}" checked`);
    expect(await snapshot(s.userId)).toEqual(before);
    // A kept row on a disconnected account may stay as it is while another account is removed.
    expect((await saveAccess(s, [kept.id])).status).toBe(303);
    expect(await grantRows(s.userId, s.app.clientId)).toEqual([kept.id]);
  });

  it("refuses a form that showed a different allowlist with 409, re-rendering the page fresh and changing nothing", async () => {
    const s = await signedIn("app-save-outdated");
    const kept = (await seedUserWithAccount(env, { email: uniqueEmail("app-save-outdated-k"), scopes: [`${G}tasks`], userId: s.userId })).account;
    await store.grants.add(s.userId, s.app.clientId, kept.id);
    const opened = await (await s.browser.fetch(appPath(s.app.clientId))).text();
    expect(shownField(opened)?.split(" ").sort()).toEqual([s.a.id, kept.id].sort());
    expect(opened).toContain(`<input type="checkbox" name="account" value="${kept.id}" checked>`);

    // Access removed elsewhere (a reconnect clearing the row, or another tab) after the page was opened.
    await store.grants.remove(s.userId, s.app.clientId, kept.id);
    const before = await snapshot(s.userId);
    const stale = await saveAccess(s, [s.a.id, kept.id], s.app.clientId, BASE, shownField(opened)?.split(" ") ?? []);
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-security-policy")).toBe(PAGE_CSP);
    const page = await stale.text();
    expect(page).toContain("This page was out of date. Review and save again.");
    expect(page).toContain(`<input type="checkbox" name="account" value="${kept.id}">`);
    expect(shownField(page)).toBe(s.a.id);
    expectPlainLanguage(page, { allow: [...shown(s), kept.email] });
    expect(await snapshot(s.userId)).toEqual(before);
    expect(await grantRows(s.userId, s.app.clientId)).toEqual([s.a.id]);

    // A form without what it showed is just as outdated.
    expect((await post(s.browser, `${appPath(s.app.clientId)}/access`, [["csrf", s.csrf], ["account", kept.id]])).status).toBe(409);
    expect(await grantRows(s.userId, s.app.clientId)).toEqual([s.a.id]);

    // The fresh page saves normally.
    const fresh = await (await s.browser.fetch(appPath(s.app.clientId))).text();
    const saved = await saveAccess(s, [s.a.id, kept.id], s.app.clientId, BASE, shownField(fresh)?.split(" ") ?? []);
    expect(saved.status).toBe(303);
    expect(await grantRows(s.userId, s.app.clientId)).toEqual([s.a.id, kept.id].sort());
  });

  it("answers 404 and changes nothing for another user's or an unknown app, or another user's account", async () => {
    const mine = await signedIn("app-idor-mine");
    const theirs = await signedIn("app-idor-theirs");
    const before = [await snapshot(mine.userId), await snapshot(theirs.userId)];
    const attempts: Array<[string, string[]]> = [
      [theirs.app.clientId, [theirs.a.id]],
      [theirs.app.clientId, []],
      [theirs.app.clientId, [mine.a.id, mine.b.id]],
      ["nope", [mine.b.id]],
      ["x".repeat(300), []],
      [mine.app.clientId, [theirs.b.id]],
      [mine.app.clientId, [mine.b.id, theirs.a.id]],
      [mine.app.clientId, ["x".repeat(300)]],
    ];
    for (const [appId, accountIds] of attempts) {
      const res = await saveAccess(mine, accountIds, appId);
      expect([appId.slice(0, 40), accountIds, res.status]).toEqual([appId.slice(0, 40), accountIds, 404]);
      const page = await res.text();
      expect(page).not.toContain(theirs.appName);
      expect(page).not.toContain(theirs.a.email);
    }
    // The existing per-row app actions keep refusing another user's app (their own status), changing nothing.
    for (const [path, fields] of [
      ["/connections/client-grant", [["client", theirs.app.clientId], ["account", mine.b.id]]],
      ["/connections/client-ungrant", [["client", theirs.app.clientId], ["account", theirs.a.id]]],
      ["/connections/client-revoke", [["client", theirs.app.clientId]]],
    ] as Array<[string, Array<[string, string]>]>) {
      const res = await post(mine.browser, path, [["csrf", mine.csrf], ...fields]);
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect([await snapshot(mine.userId), await snapshot(theirs.userId)]).toEqual(before);
    expect(await mcpToolsList(theirs.app.accessToken)).toBe(200);
  });

  it("only widens from the signed-in human's own form: no session, another site or a wrong token change nothing", async () => {
    const s = await signedIn("app-save-guard");
    const before = await snapshot(s.userId);
    const widen: Array<[string, string]> = [["account", s.a.id], ["account", s.b.id]];
    const path = `${appPath(s.app.clientId)}/access`;
    const refused: Array<[Browser, Array<[string, string]>, string | null, number]> = [
      [new Browser(), [["csrf", s.csrf], ...widen], BASE, 401],
      [s.browser, [["csrf", s.csrf], ...widen], "https://evil.example", 403],
      [s.browser, [["csrf", s.csrf], ...widen], null, 403],
      [s.browser, [["csrf", "x".repeat(43)], ...widen], BASE, 403],
      [s.browser, widen, BASE, 403],
    ];
    for (const [browser, fields, origin, status] of refused) {
      const res = await post(browser, path, fields, origin);
      expect(res.status).toBe(status);
    }
    // The AI app's own credential is no session either.
    const bearer = await new Browser().fetch(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, authorization: `Bearer ${s.app.accessToken}` },
      body: new URLSearchParams([["csrf", s.csrf], ...widen]).toString(),
    });
    expect(bearer.status).toBe(401);
    expect(await snapshot(s.userId)).toEqual(before);
  });
});

describe("/apps/:id/remove", () => {
  it("states what stops and what stays, and posts to the existing removal with the session's token", async () => {
    const s = await signedIn("app-remove", HOSTILE);
    const res = await s.browser.fetch(`${appPath(s.app.clientId)}/remove`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).not.toContain("<img");
    expect(page).toContain(`<h1 class="title">Remove ${HOSTILE_ESCAPED}?</h1>`);
    expect(page).toContain(`${HOSTILE_ESCAPED} can no longer use any of your Google accounts.`);
    expect(page).toContain("Your Google accounts stay connected, with their Google services.");
    expect(page).toContain("Other AI apps keep their own access.");
    expect(page).toContain("Nothing is deleted at Google.");
    expect(page).toContain(
      `<form method="post" action="/connections/client-revoke" class="inline"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="client" value="${s.app.clientId}"><button type="submit" class="btn btn-destructive">Remove ${HOSTILE_ESCAPED}</button></form>`,
    );
    expect(page).toContain(`<a class="btn btn-ghost" href="${appPath(s.app.clientId)}">${COPY.actions.cancel}</a>`);
    expectPlainLanguage(page, { allow: shown(s) });
  });

  it("removes only the app: its access ends, the Google accounts stay connected, and the list confirms it", async () => {
    const s = await signedIn("app-remove-do");
    const res = await post(s.browser, "/connections/client-revoke", [["csrf", s.csrf], ["client", s.app.clientId]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/apps");
    expect(await mcpToolsList(s.app.accessToken)).toBe(401);
    expect((await store.accounts.listForUser(s.userId)).map((a) => a.status)).toEqual(["active", "active"]);
    expect(flashOf(await (await s.browser.fetch("/apps")).text())?.text).toContain("Helper app-remove-do&#39;s access was removed.");
    expect((await s.browser.fetch(`${appPath(s.app.clientId)}/remove`)).status).toBe(404);
  });
});

describe("confirm-grant page", () => {
  const account = (over: Partial<PageAccount> = {}): PageAccount => ({
    id: "a_1",
    email: "w@x.test",
    isDefault: false,
    status: "active",
    scopes: [],
    services: { gmail: true, drive: true, calendar: false, sheets: false, docs: false, forms: false, tasks: false, slides: false, searchconsole: false, analytics: false, analyticsadmin: false, ads: false, groups: false, tagmanager: false, tagmanageredit: false, tagmanagerpublish: false, tagmanageradmin: false },
    ...over,
  });
  const client = { clientId: "Xk3v9QpL2mNa7", name: HOSTILE, redirectHosts: ["app.example"], approvedAt: 0, allowed: [] };

  it("asks in the approval pattern: escaped name, no account chosen, status, the write guard, both decisions in one protected form", async () => {
    const page = await renderConfirmGrantPage({
      csrf: "tok",
      token: "t1",
      client,
      hint: "w‮@x",
      choices: [account(), account({ id: "a_2", email: "h@x.test", alias: "home", isDefault: true })],
    });
    expect(page).not.toContain("<img");
    expect(page).toContain(`<h1 class="title">Allow <bdi>${HOSTILE_ESCAPED}</bdi> to use another Google account?</h1>`);
    expect(page).toContain(`<style>`);
    expect(page).not.toContain("<style>body{");
    expect(page).toContain("The app asked for: w@x</p>");
    expect(page).toContain(esc(COPY.trust.appNameNotVerified));
    expect(page).toContain(esc(COPY.trust.writeGuard));
    expect(page.match(/<form /g)).toHaveLength(1);
    expect(page).toContain('<form method="post" action="/connections/confirm-grant"><input type="hidden" name="csrf" value="tok"><input type="hidden" name="t" value="t1">');
    expect(page).toContain('<input type="radio" name="account" value="a_1" required>');
    expect(page).toContain('<input type="radio" name="account" value="a_2" required>');
    expect(page).not.toMatch(/name="account"[^>]* checked/);
    expect(page).toContain(COPY.status.active);
    expect(page).toContain(COPY.chips.default);
    expect(page).toContain(`${SERVICE_NAMES.gmail}, ${SERVICE_NAMES.drive}`);
    expect(page).toContain(`<button type="submit" name="decision" value="allow" class="btn btn-primary">Allow selected account</button>`);
    expect(page).toContain(`<button type="submit" name="decision" value="deny" class="btn btn-ghost" formnovalidate>${esc(COPY.actions.dontAllow)}</button>`);
    expect(page).toContain('<p>Access goes to <strong>app.example</strong>.</p>');
    expect(page).toContain('App ID: <span class="mono">Xk3v9QpL2mNa7</span>');
    expectPlainLanguage(page, { allow: [HOSTILE, "w@x", "app.example", "home"] });
  });

  it("leads each account with its email and shows its name cleaned and isolated", async () => {
    const page = await renderConfirmGrantPage({
      csrf: "tok",
      token: "t1",
      client,
      choices: [account({ id: "a_9", email: "real@x.test", alias: "\u202Epersonal\uFF20gmail.com" })],
    });
    expect(page).not.toContain("\u202E");
    const row = /<label class="check">[\s\S]*?<\/label>/.exec(page)?.[0] ?? "";
    expect(row).toContain('<span class="mono">real@x.test</span>');
    expect(row).toContain("<bdi>personal\uFF20gmail.com</bdi>");
    expect(row.indexOf("real@x.test")).toBeLessThan(row.indexOf("personal"));
  });

  it("offers only Don't allow when every connected account is already allowed", async () => {
    const page = await renderConfirmGrantPage({ csrf: "tok", token: "t1", client: { ...client, name: "Helper" }, choices: [] });
    expect(page).toContain("Every connected account is already allowed for <bdi>Helper</bdi>.");
    expect(page).not.toContain('value="allow"');
    expect(page).toContain('<input type="hidden" name="csrf" value="tok">');
    expect(page).toContain('value="deny"');
    expectPlainLanguage(page, { allow: ["Helper", "app.example"] });
  });
});

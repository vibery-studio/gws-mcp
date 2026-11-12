import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_SERVICES, GOOGLE_SERVICES, SERVICE_SCOPES, loadConfig, type GoogleService } from "../../src/config";
import { openStore } from "../../src/store/db";
import { COPY, SERVICE_NAMES, serviceDescription } from "../../src/web/copy";
import { openUserSettings } from "../../src/store/user-settings";
import { ADS_COPY, ADS_ERRORS, NAME_ERRORS } from "../../src/web/pages/account-details";
import { SERVICE_ERRORS } from "../../src/web/pages/account-services";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, approveClient, loginCallback, pickAtFake, redirectsToGoogle, seedGoogle } from "../auth/browser";
import { expectPlainLanguage } from "./plain-language";

const store = openStore(env);
const preset = loadConfig(env).GOOGLE_SCOPE_PRESET;
const G = "https://www.googleapis.com/auth/";
/** Gmail and Drive under the test preset. */
const GMAIL_DRIVE = [...SERVICE_SCOPES[preset].gmail, ...SERVICE_SCOPES[preset].drive];
const TASKS = [...SERVICE_SCOPES[preset].tasks];

/** The disconnect wording agreed for the sign-in and default account, verbatim. */
const SIGN_IN_DEFAULT_NOTE =
  "You can still sign in here with this Google account. It stays your default account until you choose another one; until then, AI apps that don't name an account can't use any account. AI apps that could use it will need your permission again after you reconnect it.";

function post(browser: Browser, path: string, fields: Array<[string, string]>, origin: string | null = BASE): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams(fields).toString(),
  });
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The CSRF token of the shell's sign-out form. */
async function csrfOf(browser: Browser): Promise<string> {
  const m = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/accounts")).text());
  if (!m?.[1]) throw new Error("page has no csrf field");
  return m[1];
}

/** The flash banner's inner HTML, or undefined. */
function flashOf(page: string): string | undefined {
  return /<div class="flash [^"]+" role="(?:status|alert)">([\s\S]*?)<\/div>/.exec(page)?.[1];
}

/** The banner's text without markup. */
function flashText(page: string): string | undefined {
  const inner = flashOf(page);
  return inner === undefined ? undefined : decode(inner.replace(/<[^>]+>/g, "")).trim();
}

interface PageForm {
  action: string;
  /** Hidden fields plus checked checkboxes, in order: what the browser submits. */
  fields: Array<[string, string]>;
  inner: string;
}

/** Every POST form of a page. */
function formsOf(page: string): PageForm[] {
  return [...page.matchAll(/<form method="post" action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => {
    const inner = m[2] ?? "";
    const fields = [...inner.matchAll(/<input type="(hidden|checkbox)" name="([^"]+)" value="([^"]*)"( checked)?>/g)]
      .filter((f) => f[1] === "hidden" || f[4] !== undefined)
      .map((f): [string, string] => [f[2] ?? "", decode(f[3] ?? "")]);
    return { action: decode(m[1] ?? ""), fields, inner };
  });
}

function formTo(page: string, action: string): PageForm {
  const form = formsOf(page).find((f) => f.action === action);
  if (!form) throw new Error(`no form posting to ${action}`);
  return form;
}

/** One account card on /accounts, by the account's page link. */
function cardOf(page: string, accountId: string): string {
  const card = page.split('<li class="card">').find((c) => c.includes(`href="/accounts/${encodeURIComponent(accountId)}"`));
  if (!card) throw new Error(`no card for ${accountId}`);
  return card.slice(0, card.indexOf("\n</li>"));
}

/**
 * A signed-in user whose primary (default) account holds `scopes`, with an optional second account and an
 * approved app allowed the primary one.
 */
async function signedIn(prefix: string, opts: { scopes?: string[]; alias?: string; second?: { scopes: string[]; alias?: string }; app?: string } = {}) {
  const primary = await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-a`), scopes: opts.scopes ?? GMAIL_DRIVE, isDefault: true, ...(opts.alias ? { alias: opts.alias } : {}) });
  const second = opts.second
    ? (await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-b`), scopes: opts.second.scopes, userId: primary.userId, ...(opts.second.alias ? { alias: opts.second.alias } : {}) })).account
    : undefined;
  const browser = new Browser();
  expect((await loginCallback(browser, primary.account.email)).status).toBe(302);
  const app = opts.app ? await approveClient(browser, opts.app, (form) => form.accounts.filter((a) => a.id === primary.account.id).map((a) => a.id)) : undefined;
  return { userId: primary.userId, account: primary.account, second, app, browser, csrf: await csrfOf(browser) };
}

/** Everything an account action could change for `userId`. */
async function snapshot(userId: string) {
  const accounts = await store.accounts.listForUser(userId);
  const { results: grants } = await env.DB.prepare("SELECT client_id, account_id FROM client_grants WHERE user_id = ? ORDER BY client_id, account_id").bind(userId).all();
  return { accounts, grants };
}

async function page(browser: Browser, path: string): Promise<string> {
  const res = await browser.fetch(path);
  expect([path, res.status]).toEqual([path, 200]);
  return res.text();
}

const accountUrl = (id: string, sub = "") => `/accounts/${encodeURIComponent(id)}${sub}`;

describe("Google accounts list", () => {
  it("shows one card per account: name, email, status, default, Google services and the AI apps allowed to use it", async () => {
    const s = await signedIn("acc-list", { alias: "personal", second: { scopes: TASKS }, app: "Notes helper" });
    const second = s.second;
    if (!second) throw new Error("setup");
    await store.accounts.markStatus(s.userId, second.id, "reconnect");
    const html = await page(s.browser, "/accounts");

    const a = cardOf(html, s.account.id);
    expect(a).toContain(`<h2 class="card-name"><a href="${accountUrl(s.account.id)}"><bdi>personal</bdi></a></h2>`);
    expect(a).toContain(`<p class="mono">${s.account.email}</p>`);
    expect(a).toContain(`<span class="chip chip-ok">${COPY.status.active}</span>`);
    expect(a).toContain(`<span class="chip chip-default">${COPY.chips.default}</span>`);
    expect(a).toContain(`<span class="chip">${SERVICE_NAMES.gmail}</span>`);
    expect(a).toContain(`<span class="chip">${SERVICE_NAMES.drive}</span>`);
    expect(a).toContain("Allowed for: <bdi>Notes helper</bdi>");
    expect(a).not.toContain(`/reconnect`);

    // No account name: the email is the name, in mono, once.
    const b = cardOf(html, second.id);
    expect(b).toContain(`<a href="${accountUrl(second.id)}"><span class="mono">${second.email}</span></a>`);
    expect(b.split(second.email)).toHaveLength(2);
    expect(b).toContain(`<span class="chip chip-warn">${COPY.status.reconnect}</span>`);
    expect(b).not.toContain(COPY.chips.default);
    expect(b).toContain(`<span class="chip">${SERVICE_NAMES.tasks}</span>`);
    expect(b).toContain("Allowed for: <bdi>No AI apps yet</bdi>");
    expect(b).toContain(`<a class="btn btn-primary" href="${accountUrl(second.id, "/reconnect")}">${COPY.actions.reconnect}</a>`);
    expect(b).toContain(`<a class="btn btn-ghost" href="${accountUrl(second.id)}">${COPY.actions.manageAccount}</a>`);
    expectPlainLanguage(html, { allow: [s.account.email, second.email, "Notes helper"] });
  });

  it("adds another Google account through the existing connect flow, for the one-click services only", async () => {
    const s = await signedIn("acc-add");
    const html = await page(s.browser, "/accounts");
    expect(html).toContain("Add another Google account</button>");
    const form = formTo(html, "/connections/connect");
    expect(form.fields).toEqual([["csrf", s.csrf], ...DEFAULT_CONNECT_SERVICES.map((x): [string, string] => ["service", x])]);
    for (const optIn of ["ads", "groups", "analyticsadmin", "tagmanageredit", "tagmanagerpublish", "tagmanageradmin"]) {
      expect(form.fields.some(([, v]) => v === optIn), optIn).toBe(false);
    }
    const res = await post(s.browser, form.action, form.fields);
    expect(redirectsToGoogle(res)).toBe(true);
    const google = new URL(res.headers.get("location") ?? "");
    expect(google.searchParams.get("login_hint")).toBeNull();
    expect(google.searchParams.get("scope")?.split(" ").sort()).toEqual(
      [...new Set(["openid", "email", ...DEFAULT_CONNECT_SERVICES.flatMap((x) => SERVICE_SCOPES[preset][x])])].sort(),
    );
  });

  it("after a new account connects, says the existing AI apps can't use it yet and links to them; a reconnect says only connected", async () => {
    const s = await signedIn("acc-flash", { app: "Notes helper" });
    const emailC = uniqueEmail("acc-flash-c");
    await seedGoogle(emailC);
    const form = formTo(await page(s.browser, "/accounts"), "/connections/connect");
    const start = await post(s.browser, form.action, form.fields);
    expect((await s.browser.fetch(await pickAtFake(start.headers.get("location") ?? "", emailC))).headers.get("location")).toBe("/accounts");
    const first = await page(s.browser, "/accounts");
    expect(flashText(first)).toBe(`${emailC} is connected. Your existing AI apps can't use ${emailC} yet. ${COPY.actions.manageAiApps}`);
    expect(flashOf(first)).toContain(`<a href="/apps">${COPY.actions.manageAiApps}</a>`);
    expect(first).toMatch(/<div class="flash flash-success" role="status">/);
    expect(flashOf(await page(s.browser, "/accounts"))).toBeUndefined();

    const reconnect = formTo(await page(s.browser, accountUrl(s.account.id, "/reconnect")), "/connections/connect");
    const again = await post(s.browser, reconnect.action, reconnect.fields);
    await s.browser.fetch(await pickAtFake(again.headers.get("location") ?? "", s.account.email));
    expect(flashText(await page(s.browser, "/accounts"))).toBe(`${s.account.email} is connected.`);
  });

  it("says a disconnect happened once the confirmation's form was sent", async () => {
    const s = await signedIn("acc-disc-flash", { second: { scopes: TASKS, alias: "work" } });
    const second = s.second;
    if (!second) throw new Error("setup");
    const form = formTo(await page(s.browser, accountUrl(second.id, "/disconnect")), "/connections/disconnect");
    expect(form.fields).toEqual([["csrf", s.csrf], ["account", second.id]]);
    const res = await post(s.browser, form.action, form.fields);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/accounts"]);
    const html = await page(s.browser, "/accounts");
    expect(flashText(html)).toBe("work was disconnected.");
    expect(cardOf(html, second.id)).toContain(`<span class="chip chip-off">${COPY.status.disconnected}</span>`);
    expect(await store.accounts.get(s.userId, second.id)).toMatchObject({ status: "disconnected", hasRefreshToken: false });
  });
});

describe("account names with hidden characters", () => {
  it("shows a name stored with bidi and zero-width characters cleaned on every page, button and flash", async () => {
    const s = await signedIn("acc-hidden", { second: { scopes: TASKS } });
    const second = s.second;
    if (!second) throw new Error("setup");
    // Written through the store directly, as an AI app or the older rename form can.
    await store.accounts.setAlias(s.userId, second.id, "pay\u202Eli\u200Bve\u2060");
    await store.accounts.setAlias(s.userId, s.account.id, "\u200B\u202E");
    const noHidden = (path: string, html: string) => expect([path, /\p{Cf}/u.test(html)]).toEqual([path, false]);

    const list = await page(s.browser, "/accounts");
    noHidden("/accounts", list);
    expect(cardOf(list, second.id)).toContain(`<a href="${accountUrl(second.id)}"><bdi>paylive</bdi></a>`);
    // Nothing left once cleaned: the email is the name.
    expect(cardOf(list, s.account.id)).toContain(`<a href="${accountUrl(s.account.id)}"><span class="mono">${s.account.email}</span></a>`);

    const details = await page(s.browser, accountUrl(second.id));
    noHidden("details", details);
    expect(details).toContain('<h1 class="title"><bdi>paylive</bdi></h1>');
    const makeDefault = formTo(details, "/connections/set-default");
    expect((await post(s.browser, makeDefault.action, makeDefault.fields)).status).toBe(303);
    const defaulted = await page(s.browser, accountUrl(second.id));
    noHidden("details after make default", defaulted);
    expect(flashText(defaulted)).toBe("paylive is now your default account.");

    const confirm = await page(s.browser, accountUrl(second.id, "/disconnect"));
    noHidden("disconnect", confirm);
    expect(confirm).toContain('<h1 class="title">Disconnect paylive?</h1>');
    expect(confirm).toContain("<li>All your AI apps will stop using paylive through gws-mcp.</li>");
    const form = formTo(confirm, "/connections/disconnect");
    expect(form.inner).toContain('<button type="submit" class="btn btn-destructive">Disconnect paylive</button>');
    expect((await post(s.browser, form.action, form.fields)).status).toBe(303);
    const after = await page(s.browser, "/accounts");
    noHidden("/accounts after disconnect", after);
    expect(flashText(after)).toBe("paylive was disconnected.");
  });
});

describe("account details", () => {
  it("shows the name, default, read-only Google services, the AI apps that can use it, and the way to disconnect", async () => {
    const s = await signedIn("acc-details", { alias: "personal", second: { scopes: TASKS, alias: "work" }, app: "Notes helper" });
    const second = s.second;
    if (!s.app || !second) throw new Error("setup");
    const mine = await page(s.browser, accountUrl(s.account.id));
    expect(mine).toContain('<h1 class="title"><bdi>personal</bdi></h1>');
    expect(mine).toContain(`<p class="mono">${s.account.email}</p>`);
    expect(mine).toContain('<input type="text" id="account-name" name="alias" value="personal"');
    expect(formTo(mine, `${accountUrl(s.account.id)}/name`).fields).toEqual([["csrf", s.csrf]]);
    expect(mine).toContain("<bdi>personal</bdi> is your default account.");
    expect(formsOf(mine).some((f) => f.action === "/connections/set-default")).toBe(false);
    expect(mine).toContain(`<span class="chip">${SERVICE_NAMES.gmail}</span>`);
    expect(mine).not.toContain('type="checkbox"');
    expect(mine).toContain(`<a class="btn btn-ghost" href="${accountUrl(s.account.id, "/services")}">${COPY.actions.addGoogleServices}</a>`);
    expect(mine).toContain(`<a href="/apps/${encodeURIComponent(s.app.clientId)}"><bdi>Notes helper</bdi></a>`);
    expect(mine).toContain(`<a class="btn btn-danger" href="${accountUrl(s.account.id, "/disconnect")}">${COPY.actions.disconnectAccount}</a>`);
    expectPlainLanguage(mine, { allow: [s.account.email, "Notes helper"] });

    const other = await page(s.browser, accountUrl(second.id));
    expect(other).toContain("Your default account is <bdi>personal</bdi>.");
    expect(other).toContain(COPY.empty.noAppsForAccount);
    const makeDefault = formTo(other, "/connections/set-default");
    expect(makeDefault.fields).toEqual([["csrf", s.csrf], ["account", second.id]]);
    const res = await post(s.browser, makeDefault.action, makeDefault.fields);
    expect([res.status, res.headers.get("location")]).toEqual([303, accountUrl(second.id)]);
    const after = await page(s.browser, accountUrl(second.id));
    expect(flashText(after)).toBe("work is now your default account.");
    expect(after).toContain("<bdi>work</bdi> is your default account.");
  });

  it("saves the account name and clears it, returning to the details with a confirmation", async () => {
    const s = await signedIn("acc-rename");
    const res = await post(s.browser, `${accountUrl(s.account.id)}/name`, [["csrf", s.csrf], ["alias", "  Work  "]]);
    expect([res.status, res.headers.get("location")]).toEqual([303, accountUrl(s.account.id)]);
    expect((await store.accounts.get(s.userId, s.account.id))?.alias).toBe("work");
    const html = await page(s.browser, accountUrl(s.account.id));
    expect(flashText(html)).toBe("Account name saved.");
    expect(html).toContain('<h1 class="title"><bdi>work</bdi></h1>');
    expect((await post(s.browser, `${accountUrl(s.account.id)}/name`, [["csrf", s.csrf], ["alias", ""]])).status).toBe(303);
    expect((await store.accounts.get(s.userId, s.account.id))?.alias).toBeUndefined();
  });

  it.each([
    ["an @", 'a@b"><script>x</script>', NAME_ERRORS.invalid],
    ["a hidden character", "pay‮live", NAME_ERRORS.invalid],
    ["65 characters", "x".repeat(65), NAME_ERRORS.invalid],
    ["a name another account uses", "WORK", NAME_ERRORS.taken],
    ["no name field", null, NAME_ERRORS.missing],
  ] as const)("refuses %s beside the field, keeping what was typed and changing nothing", async (_label, value, message) => {
    const s = await signedIn("acc-rename-bad", { alias: "home", second: { scopes: TASKS, alias: "work" } });
    const before = await snapshot(s.userId);
    const res = await post(s.browser, `${accountUrl(s.account.id)}/name`, [["csrf", s.csrf], ...(value === null ? [] : [["alias", value] as [string, string]])]);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(`<p class="field-error" id="account-name-error">${message}</p>`);
    expect(html).toContain('aria-describedby="account-name-hint account-name-error" aria-invalid="true">');
    expect(html).not.toContain("<script>x");
    if (value !== null) expect(decode(/id="account-name" name="alias" value="([^"]*)"/.exec(html)?.[1] ?? "")).toBe(value);
    expect(formTo(html, `${accountUrl(s.account.id)}/name`).fields).toEqual([["csrf", s.csrf]]);
    expect(await snapshot(s.userId)).toEqual(before);
    expectPlainLanguage(html, { allow: [s.account.email, value ?? ""] });
  });
});

describe("add Google services", () => {
  it("lists the connected services and offers only the others, each with its plain description", async () => {
    const s = await signedIn("acc-svc");
    const html = await page(s.browser, accountUrl(s.account.id, "/services"));
    const connected: GoogleService[] = ["gmail", "drive"];
    const missing = GOOGLE_SERVICES.filter((x) => !connected.includes(x));
    for (const x of connected) {
      expect(html).toContain(`<li><strong>${SERVICE_NAMES[x]}</strong> <span class="hint">${serviceDescription(preset, x)}</span></li>`);
      expect(html).not.toContain(`name="service" value="${x}"`);
    }
    const form = formTo(html, accountUrl(s.account.id, "/services"));
    expect([...form.inner.matchAll(/name="service" value="([^"]+)"/g)].map((m) => m[1])).toEqual(missing);
    for (const x of missing) {
      expect(form.inner).toContain(
        `<input type="checkbox" name="service" value="${x}"><span class="check-body"><span>${SERVICE_NAMES[x]}</span><span class="hint">${serviceDescription(preset, x).replace(/'/g, "&#39;")}</span>`,
      );
    }
    expect(form.fields).toEqual([["csrf", s.csrf]]);
    expect(form.inner).toContain(`${COPY.actions.continueToGoogle}</button>`);
    expect(form.inner).toContain(`<a class="btn btn-ghost" href="${accountUrl(s.account.id)}">${COPY.actions.cancel}</a>`);
    expectPlainLanguage(html, { allow: [s.account.email] });
  });

  it("continues to Google for exactly the chosen services, with the account chosen, and adds them on return", async () => {
    const s = await signedIn("acc-svc-go");
    const res = await post(s.browser, accountUrl(s.account.id, "/services"), [["csrf", s.csrf], ["service", "tasks"], ["service", "forms"]]);
    expect(redirectsToGoogle(res)).toBe(true);
    const google = new URL(res.headers.get("location") ?? "");
    expect(google.searchParams.get("login_hint")).toBe(s.account.email);
    expect(google.searchParams.get("include_granted_scopes")).toBe("true");
    expect(google.searchParams.get("scope")?.split(" ").sort()).toEqual(["openid", "email", ...SERVICE_SCOPES[preset].tasks, ...SERVICE_SCOPES[preset].forms].sort());
    expect((await s.browser.fetch(await pickAtFake(google.toString(), s.account.email))).headers.get("location")).toBe("/accounts");
    expect((await store.accounts.get(s.userId, s.account.id))?.scopes).toEqual(expect.arrayContaining([...GMAIL_DRIVE, `${G}tasks`, `${G}forms.body`]));
  });

  it.each([
    ["no service", [], SERVICE_ERRORS.none, []],
    ["a service it already has", ["tasks", "gmail"], SERVICE_ERRORS.notOffered, ["tasks"]],
    ["an unknown service", ["tasks", "photos"], SERVICE_ERRORS.notOffered, ["tasks"]],
  ] as const)("refuses %s beside the choices, keeping valid choices and starting nothing", async (_label, chosen, message, kept) => {
    const s = await signedIn("acc-svc-bad");
    const res = await post(s.browser, accountUrl(s.account.id, "/services"), [["csrf", s.csrf], ...chosen.map((x): [string, string] => ["service", x])]);
    expect(res.status).toBe(400);
    expect(redirectsToGoogle(res)).toBe(false);
    const html = await res.text();
    expect(html).toContain(`<p class="field-error" id="services-error" role="alert">${message}</p>`);
    expect(formTo(html, accountUrl(s.account.id, "/services")).fields).toEqual([["csrf", s.csrf], ...kept.map((x): [string, string] => ["service", x])]);
    expect(s.browser.cookieNames("__Host-gws_gstate")).toEqual([]);
    expectPlainLanguage(html, { allow: [s.account.email] });
  });

  it("says when every service is connected, with only the way back", async () => {
    const all = GOOGLE_SERVICES.flatMap((x) => SERVICE_SCOPES[preset][x]);
    const s = await signedIn("acc-svc-all", { scopes: [...all] });
    const html = await page(s.browser, accountUrl(s.account.id, "/services"));
    expect(html).toContain(`<p>${COPY.empty.allServicesConnected}</p>`);
    expect(html).toContain(`<a class="btn btn-ghost" href="${accountUrl(s.account.id)}">${COPY.actions.backToAccount}</a>`);
    expect(formsOf(html).map((f) => f.action)).toEqual(["/logout"]);
    expect(await page(s.browser, accountUrl(s.account.id))).toContain(COPY.empty.allServicesConnected);
  });
});

describe("reconnect", () => {
  it("explains a needed reconnect and reconnects the account's current services through the existing connect flow", async () => {
    const s = await signedIn("acc-recon");
    await store.accounts.markStatus(s.userId, s.account.id, "reconnect");
    const html = await page(s.browser, accountUrl(s.account.id, "/reconnect"));
    expect(html).toContain("needs permission from Google before it can be used again.");
    expect(html).toContain(`You'll go to Google to review the access for <span class="mono">${s.account.email}</span>.`);
    const form = formTo(html, "/connections/connect");
    expect(form.fields).toEqual([["csrf", s.csrf], ["account", s.account.id], ["service", "gmail"], ["service", "drive"]]);
    expect(form.inner).toContain(`${COPY.actions.reconnect}</button>`);
    expectPlainLanguage(html, { allow: [s.account.email] });

    const res = await post(s.browser, form.action, form.fields);
    expect(redirectsToGoogle(res)).toBe(true);
    const google = new URL(res.headers.get("location") ?? "");
    expect(google.searchParams.get("login_hint")).toBe(s.account.email);
    expect(google.searchParams.get("scope")?.split(" ").sort()).toEqual(["openid", "email", ...GMAIL_DRIVE].sort());
    await s.browser.fetch(await pickAtFake(google.toString(), s.account.email));
    expect((await store.accounts.get(s.userId, s.account.id))?.status).toBe("active");
  });

  it("sends a disconnected account to choose its services first, saying its AI apps will need permission again", async () => {
    const s = await signedIn("acc-recon-disc", { app: "Notes helper" });
    await store.accounts.wipeToken(s.userId, s.account.id);
    const html = await page(s.browser, accountUrl(s.account.id, "/reconnect"));
    expect(html).toContain("is disconnected. Reconnect it to use it with your AI apps again.");
    expect(html).toContain("will need your permission again.");
    expect(html).toContain(`<a class="btn btn-primary" href="${accountUrl(s.account.id, "/services")}">${COPY.actions.reconnect}</a>`);
    expect(formsOf(html).map((f) => f.action)).toEqual(["/logout"]);
    expectPlainLanguage(html, { allow: [s.account.email] });
  });
});

describe("disconnect confirmation", () => {
  it("states what stops and what stays, with the sign-in and default account wording for that account", async () => {
    const s = await signedIn("acc-disc", { alias: "personal", second: { scopes: TASKS, alias: "work" } });
    const second = s.second;
    if (!second) throw new Error("setup");
    const html = await page(s.browser, accountUrl(s.account.id, "/disconnect"));
    expect(html).toContain('<h1 class="title">Disconnect personal?</h1>');
    expect(html).toContain("<li>All your AI apps will stop using personal through gws-mcp.</li>");
    expect(html).toContain("<li>Google access for this account will be removed.</li>");
    expect(html).toContain("<li>Your other Google accounts are not affected.</li>");
    expect(html).toContain(`<li>${COPY.trust.googleDataNotDeleted}</li>`);
    expect(decode(html)).toContain(`<p class="flash flash-warning confirm">${SIGN_IN_DEFAULT_NOTE}</p>`);
    // The warning is part of the confirmation and comes before the buttons that act on it.
    const confirmBlock = html.slice(html.indexOf('<div class="confirm">'));
    const warning = confirmBlock.indexOf('<p class="flash flash-warning confirm">');
    expect(warning).toBeGreaterThan(confirmBlock.indexOf('<h1 class="title">Disconnect personal?</h1>'));
    expect(warning).toBeLessThan(confirmBlock.indexOf('class="btn btn-destructive"'));
    expect(warning).toBeLessThan(confirmBlock.indexOf(`<a class="btn btn-ghost" href="${accountUrl(s.account.id)}">${COPY.actions.cancel}</a>`));
    const form = formTo(html, "/connections/disconnect");
    expect(form.fields).toEqual([["csrf", s.csrf], ["account", s.account.id]]);
    expect(form.inner).toContain('<button type="submit" class="btn btn-destructive">Disconnect personal</button>');
    expect(html).toContain(`<a class="btn btn-ghost" href="${accountUrl(s.account.id)}">${COPY.actions.cancel}</a>`);
    expectPlainLanguage(html, { allow: [s.account.email] });

    // Not the sign-in account and not the default: only that a reconnect needs permission again.
    const other = decode(await page(s.browser, accountUrl(second.id, "/disconnect")));
    expect(other).toContain('<p class="muted confirm">AI apps that could use it will need your permission again after you reconnect it.</p>');
    expect(other).not.toContain("still sign in");
    expect(other).not.toContain("default account");

    // The default but not the sign-in account, and the reverse.
    await store.accounts.setDefault(s.userId, second.id);
    const defaulted = decode(await page(s.browser, accountUrl(second.id, "/disconnect")));
    expect(defaulted).toContain(`<p class="flash flash-warning confirm">${SIGN_IN_DEFAULT_NOTE.replace("You can still sign in here with this Google account. ", "")}</p>`);
    const signInOnly = decode(await page(s.browser, accountUrl(s.account.id, "/disconnect")));
    expect(signInOnly).toContain(
      '<p class="flash flash-warning confirm">You can still sign in here with this Google account. AI apps that could use it will need your permission again after you reconnect it.</p>',
    );
  });

  it("offers no disconnect for an account that is already disconnected", async () => {
    const s = await signedIn("acc-disc-again");
    await store.accounts.wipeToken(s.userId, s.account.id);
    const html = await page(s.browser, accountUrl(s.account.id, "/disconnect"));
    expect(formsOf(html).map((f) => f.action)).toEqual(["/logout"]);
    expect(html).toContain(`<a class="btn btn-primary" href="${accountUrl(s.account.id, "/reconnect")}">${COPY.actions.reconnect}</a>`);
    const details = await page(s.browser, accountUrl(s.account.id));
    expect(details).not.toContain(accountUrl(s.account.id, "/disconnect"));
    expect(formsOf(details).some((f) => f.action === "/connections/set-default")).toBe(false);
    expectPlainLanguage(html, { allow: [s.account.email] });
  });
});

describe("every account page", () => {
  it("escapes user data, passes the plain-language check, and puts the session's CSRF token first in every form", async () => {
    const alias = `<b>x</b>'"& mcp token`;
    const appName = "<script>alert(1)</script> MCP Client";
    const s = await signedIn("acc-all", { alias, second: { scopes: TASKS }, app: appName });
    const second = s.second;
    if (!second) throw new Error("setup");
    await store.accounts.markStatus(s.userId, second.id, "reconnect");
    const stored = (await store.accounts.get(s.userId, s.account.id))?.alias ?? "";
    const paths = [
      "/accounts",
      ...[s.account.id, second.id].flatMap((id) => ["", "/services", "/reconnect", "/disconnect"].map((sub) => accountUrl(id, sub))),
    ];
    for (const path of paths) {
      const html = await page(s.browser, path);
      expect([path, html.includes("<script"), html.includes("<b>x</b>")]).toEqual([path, false, false]);
      expectPlainLanguage(html, { allow: [s.account.email, second.email, stored, appName] });
      const forms = [...html.matchAll(/<form method="post" action="[^"]*"[^>]*>\s*(<input[^>]*>)/g)].map((m) => m[1]);
      expect(forms.length).toBeGreaterThan(0);
      expect([...html.matchAll(/<form /g)]).toHaveLength(forms.length);
      for (const first of forms) expect([path, first]).toEqual([path, `<input type="hidden" name="csrf" value="${s.csrf}">`]);
    }
    expect(await page(s.browser, accountUrl(s.account.id))).toContain("&lt;b&gt;x&lt;/b&gt;&#39;&quot;&amp; mcp token");
    // The plain-language check still reads the page's own words around an allowed user value.
    expect(() => expectPlainLanguage(`<p>Revoke ${stored}</p>`, { allow: [stored] })).toThrow(/"Revoke"/);
  });
});

describe("account POST ownership", () => {
  it("answers 404 to another user's or an unknown account on every account POST, changing nothing and starting nothing", async () => {
    const mine = await signedIn("acc-idor-mine");
    const theirs = await signedIn("acc-idor-theirs");
    const before = [await snapshot(mine.userId), await snapshot(theirs.userId)];
    for (const id of [theirs.account.id, "a_nope", "x".repeat(300)]) {
      for (const [path, fields] of [
        [accountUrl(id, "/name"), [["alias", "stolen"]]],
        [accountUrl(id, "/services"), [["service", "tasks"]]],
      ] as Array<[string, Array<[string, string]>]>) {
        const res = await post(mine.browser, path, [["csrf", mine.csrf], ...fields]);
        expect([path, res.status, redirectsToGoogle(res)]).toEqual([path, 404, false]);
        const html = await res.text();
        expect(html).not.toContain(theirs.account.email);
      }
    }
    expect(mine.browser.cookieNames("__Host-gws_gstate")).toEqual([]);
    expect(mine.browser.cookieNames("__Host-gws_flash")).toEqual([]);
    expect([await snapshot(mine.userId), await snapshot(theirs.userId)]).toEqual(before);
  });
});

describe("Google Ads details on the account page", () => {
  const ADS = [...SERVICE_SCOPES[preset].ads];
  const settings = openUserSettings(env);
  const fakeCode = () => `FAKE-dev-code-${crypto.randomUUID().slice(0, 8)}`;
  const adsUrl = (id: string) => accountUrl(id, "/ads");

  it("shows the section only for an account with Google Ads connected, with an empty masked field", async () => {
    const s = await signedIn("ads-show", { second: { scopes: [...GMAIL_DRIVE, ...ADS] } });
    if (!s.second) throw new Error("setup");
    expect(await page(s.browser, accountUrl(s.account.id))).not.toContain(ADS_COPY.codeLabel);
    const html = await page(s.browser, accountUrl(s.second.id));
    expect(html).toContain(`<h2>${ADS_COPY.title}</h2>`);
    expect(decode(html)).toContain(ADS_COPY.missing);
    expect(html).toContain('<input type="password" id="ads-code" name="developerCode" value=""');
    expect(formTo(html, adsUrl(s.second.id)).fields).toEqual([["csrf", s.csrf]]);
    expect(formsOf(html).some((f) => f.action === `${adsUrl(s.second?.id ?? "")}/remove`)).toBe(false);
    expectPlainLanguage(html, { allow: [s.account.email, s.second.email] });
  });

  it("saves, keeps, replaces and removes the developer code without ever showing it again", async () => {
    const s = await signedIn("ads-save", { scopes: [...GMAIL_DRIVE, ...ADS] });
    const id = s.account.id;
    const first = fakeCode();
    let res = await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", first], ["managerId", "123-456-7890"]]);
    expect([res.status, res.headers.get("location")]).toEqual([303, accountUrl(id)]);
    expect(await settings.get(s.userId, "ads.developer_token")).toBe(first);
    expect(await settings.get(s.userId, "ads.login_customer_id")).toBe("1234567890");
    let html = await page(s.browser, accountUrl(id));
    expect(flashText(html)).toBe("Google Ads details saved.");
    expect(html).toContain(ADS_COPY.saved);
    expect(html).toContain('<input type="password" id="ads-code" name="developerCode" value=""');
    expect(html).toContain('name="managerId" value="123-456-7890"');
    expect(html.includes(first)).toBe(false);
    expectPlainLanguage(html, { allow: [s.account.email] });

    // An empty code keeps the saved one; an empty manager ID removes it.
    res = await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", ""], ["managerId", ""]]);
    expect(res.status).toBe(303);
    expect(await settings.get(s.userId, "ads.developer_token")).toBe(first);
    expect(await settings.isSet(s.userId, "ads.login_customer_id")).toBe(false);

    const second = fakeCode();
    expect((await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", second], ["managerId", ""]])).status).toBe(303);
    expect(await settings.get(s.userId, "ads.developer_token")).toBe(second);
    html = await page(s.browser, accountUrl(id));
    expect([html.includes(first), html.includes(second)]).toEqual([false, false]);

    const remove = formTo(html, `${adsUrl(id)}/remove`);
    expect(remove.fields).toEqual([["csrf", s.csrf]]);
    res = await post(s.browser, remove.action, remove.fields);
    expect([res.status, res.headers.get("location")]).toEqual([303, accountUrl(id)]);
    expect(await settings.isSet(s.userId, "ads.developer_token")).toBe(false);
    html = await page(s.browser, accountUrl(id));
    expect(flashText(html)).toBe("Google Ads details removed.");
    expect(decode(html)).toContain(ADS_COPY.missing);
  });

  it("refuses a bad code or manager ID with the reason beside the field, never showing the code, and saves nothing", async () => {
    const s = await signedIn("ads-bad", { scopes: [...GMAIL_DRIVE, ...ADS] });
    const id = s.account.id;
    const badCode = "FAKE bad code with spaces";
    let res = await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", badCode], ["managerId", "123-456-7890"]]);
    expect(res.status).toBe(400);
    let html = await res.text();
    expect(html).toContain(`<p class="field-error" id="ads-code-error">${ADS_ERRORS.codeInvalid.replace(/'/g, "&#39;")}</p>`);
    expect(html.includes(badCode)).toBe(false);
    expect(html).toContain('name="managerId" value="123-456-7890"');
    expectPlainLanguage(html, { allow: [s.account.email] });

    res = await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", ""], ["managerId", ""]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(ADS_ERRORS.codeMissing);

    const good = fakeCode();
    res = await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", good], ["managerId", "12-34"]]);
    expect(res.status).toBe(400);
    html = await res.text();
    expect(html).toContain(ADS_ERRORS.managerInvalid);
    expect(html).toContain('name="managerId" value="12-34"');
    expect(html.includes(good)).toBe(false);
    // Both fields are checked before either is saved.
    expect([await settings.isSet(s.userId, "ads.developer_token"), await settings.isSet(s.userId, "ads.login_customer_id")]).toEqual([false, false]);
  });

  it("shows a saved value that no longer decrypts as such (never an error page), with save-again and remove", async () => {
    const s = await signedIn("ads-unreadable", { scopes: [...GMAIL_DRIVE, ...ADS] });
    const id = s.account.id;
    const code = fakeCode();
    await settings.set(s.userId, "ads.developer_token", code);
    await settings.set(s.userId, "ads.login_customer_id", "5550004444");
    const corrupt = (key: string) =>
      env.DB.prepare("UPDATE user_settings SET value_ct = ? WHERE user_id = ? AND key = ?").bind("A".repeat(40), s.userId, key).run();
    await corrupt("ads.login_customer_id");
    let html = await page(s.browser, accountUrl(id));
    expect(decode(html)).toContain(ADS_COPY.saved);
    expect(decode(html)).toContain(ADS_COPY.managerUnreadable);
    expect(html).toContain('name="managerId" value=""');
    expectPlainLanguage(html, { allow: [s.account.email] });

    await corrupt("ads.developer_token");
    html = await page(s.browser, accountUrl(id));
    expect(decode(html)).toContain(ADS_COPY.unreadable);
    expect(decode(html)).not.toContain(ADS_COPY.keepHint);
    expectPlainLanguage(html, { allow: [s.account.email] });
    // An unreadable code is nothing to keep: the field must be filled to save.
    const empty = await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", ""], ["managerId", ""]]);
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain(ADS_ERRORS.codeMissing);
    // Saving again fixes it.
    expect((await post(s.browser, adsUrl(id), [["csrf", s.csrf], ["developerCode", code], ["managerId", "555-000-4444"]])).status).toBe(303);
    expect([await settings.get(s.userId, "ads.developer_token"), await settings.get(s.userId, "ads.login_customer_id")]).toEqual([code, "5550004444"]);
    // Remove clears unreadable values too.
    await corrupt("ads.developer_token");
    const remove = formTo(await page(s.browser, accountUrl(id)), `${adsUrl(id)}/remove`);
    expect((await post(s.browser, remove.action, remove.fields)).status).toBe(303);
    expect([await settings.isSet(s.userId, "ads.developer_token"), await settings.isSet(s.userId, "ads.login_customer_id")]).toEqual([false, false]);
  });

  it("offers removing saved details on every account page once no account has Google Ads, and the last Ads account was disconnected", async () => {
    const s = await signedIn("ads-gone", { scopes: GMAIL_DRIVE, second: { scopes: [...GMAIL_DRIVE, ...ADS] } });
    if (!s.second) throw new Error("setup");
    const adsAccount = s.second;
    await settings.set(s.userId, "ads.developer_token", fakeCode());
    await settings.set(s.userId, "ads.login_customer_id", "5550005555");
    await store.accounts.wipeToken(s.userId, adsAccount.id);
    for (const id of [s.account.id, adsAccount.id]) {
      const html = await page(s.browser, accountUrl(id));
      expect(decode(html)).toContain(ADS_COPY.savedElsewhere);
      expect(html).not.toContain('id="ads-code"');
      expect(formTo(html, `${adsUrl(id)}/remove`).fields).toEqual([["csrf", s.csrf]]);
      expectPlainLanguage(html, { allow: [s.account.email, adsAccount.email] });
    }
    const remove = formTo(await page(s.browser, accountUrl(adsAccount.id)), `${adsUrl(adsAccount.id)}/remove`);
    const res = await post(s.browser, remove.action, remove.fields);
    expect([res.status, res.headers.get("location")]).toEqual([303, accountUrl(adsAccount.id)]);
    expect([await settings.isSet(s.userId, "ads.developer_token"), await settings.isSet(s.userId, "ads.login_customer_id")]).toEqual([false, false]);
    const after = await page(s.browser, accountUrl(adsAccount.id));
    expect(flashText(after)).toBe("Google Ads details removed.");
    expect(decode(after)).not.toContain(ADS_COPY.savedElsewhere);
  });

  it("never shows back a rejected manager ID that isn't digits, spaces and dashes, such as a developer code in the wrong field", async () => {
    const s = await signedIn("ads-wrong-field", { scopes: [...GMAIL_DRIVE, ...ADS] });
    const pasted = fakeCode();
    const res = await post(s.browser, adsUrl(s.account.id), [["csrf", s.csrf], ["developerCode", fakeCode()], ["managerId", pasted]]);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(ADS_ERRORS.managerInvalid);
    expect(html.includes(pasted)).toBe(false);
    expect(html).toContain('name="managerId" value=""');
    expect([await settings.isSet(s.userId, "ads.developer_token"), await settings.isSet(s.userId, "ads.login_customer_id")]).toEqual([false, false]);
  });

  it("refuses a missing or wrong CSRF field, another user's account and an account without Google Ads, changing nothing", async () => {
    const mine = await signedIn("ads-guard-mine", { scopes: [...GMAIL_DRIVE, ...ADS], second: { scopes: GMAIL_DRIVE } });
    const theirs = await signedIn("ads-guard-theirs", { scopes: [...GMAIL_DRIVE, ...ADS] });
    if (!mine.second) throw new Error("setup");
    const code = fakeCode();
    await settings.set(theirs.userId, "ads.developer_token", code);
    for (const csrf of [[], [["csrf", "wrong"]]] as Array<Array<[string, string]>>) {
      for (const path of [adsUrl(mine.account.id), `${adsUrl(mine.account.id)}/remove`]) {
        const res = await post(mine.browser, path, [...csrf, ["developerCode", fakeCode()]]);
        expect([path, res.status]).toEqual([path, 403]);
      }
    }
    for (const path of [adsUrl(theirs.account.id), `${adsUrl(theirs.account.id)}/remove`, adsUrl("a_nope")]) {
      const res = await post(mine.browser, path, [["csrf", mine.csrf], ["developerCode", fakeCode()]]);
      expect([path, res.status]).toEqual([path, 404]);
    }
    const noAds = await post(mine.browser, adsUrl(mine.second.id), [["csrf", mine.csrf], ["developerCode", fakeCode()]]);
    expect(noAds.status).toBe(400);
    expect(await settings.isSet(mine.userId, "ads.developer_token")).toBe(false);
    expect(await settings.get(theirs.userId, "ads.developer_token")).toBe(code);
  });
});

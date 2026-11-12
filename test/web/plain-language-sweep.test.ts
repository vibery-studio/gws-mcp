import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CAPABILITIES_TEXT } from "../../src/auth/consent-page";
import { DEFAULT_NEXT } from "../../src/auth/google-flow";
import { DEFAULT_CONNECT_SERVICES, SERVICE_SCOPES } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { PRIVATE_MESSAGE, PRIVATE_TITLE } from "../../src/auth/routes";
import { openAccessStore } from "../../src/store/access";
import { openStore } from "../../src/store/db";
import { ACCESS_COPY } from "../../src/web/access-copy";
import { COPY, GLOSSARY, PLAIN_ERROR_CODES, connectAppHelp, plainError } from "../../src/web/copy";
import { setFlash, type Flash } from "../../src/web/flash";
import { ADS_COPY } from "../../src/web/pages/account-details";
import { SETTING_LINK_COPY } from "../../src/web/pages/setting-link";
import { mintSettingLink } from "../../src/core/setting-links";
import { gatedStep, mintApprovalLink } from "../../src/core/human-approval";
import { APPROVAL_LINK_COPY } from "../../src/web/pages/approval-link";
import { workersSettingLinkPort } from "../../src/runtime/workers/ports";
import { HOME_COPY, SIGN_IN_COPY } from "../../src/web/pages/home";
import { PAGE_CSP } from "../../src/web/ui";
import { fakeTransport, seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, approveClient, authorizePath, config, loginCallback, pkce, registerClient, seedGoogle } from "../auth/browser";
import { expectPlainLanguage } from "./plain-language";

/**
 * One sweep over every page a person can reach: each must pass the plain-language check, show its key
 * A05 labels and carry the right security policy; and on every page that shows a flash, a failed action is
 * worded by `plainError`, never as its code.
 */

const store = openStore(env);
const preset = config.GOOGLE_SCOPE_PRESET;
const GMAIL_DRIVE = [...SERVICE_SCOPES[preset].gmail, ...SERVICE_SCOPES[preset].drive];
const TASKS = [...SERVICE_SCOPES[preset].tasks];
const APP_NAME = "Sweep Helper";
const CONNECTOR = config.mcpResource;

function post(browser: Browser, path: string, fields: Array<[string, string]>, origin: string | null = BASE): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams(fields).toString(),
  });
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The flash banner's role and text without markup, or undefined. */
function banner(page: string): { role: string; text: string } | undefined {
  const m = /<div class="flash [^"]+" role="(status|alert)">([\s\S]*?)<\/div>/.exec(page);
  return m ? { role: m[1] ?? "", text: decode((m[2] ?? "").replace(/<[^>]+>/g, "")).trim() } : undefined;
}

/** A pending request of the app to use one more account, as `accounts.grant` creates it; returns its link token. */
async function grantLink(userId: string, clientId: string): Promise<string> {
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
  const w = await cap.requestGrant();
  if (!w.applied) throw new Error("grant request was only planned");
  return new URL(w.value.url).searchParams.get("t") ?? "";
}

/** A one-time link for the user to set `key`, as `settings.requestLink` makes it; returns its link token. */
async function settingLink(userId: string, clientId: string, key: "ads.developer_token" | "ads.login_customer_id"): Promise<string> {
  const deps = { links: env.CACHE_KV, rate: store.rate, port: workersSettingLinkPort(env), baseUrl: BASE, auth: { userId, clientId }, executeId: "e-sweep", now: Date.now() };
  return new URL((await mintSettingLink(deps, key)).link.url).searchParams.get("t") ?? "";
}

/** An approval link for a public share on the user's account, as a dry run makes it; returns its link token. */
async function approvalLink(userId: string, clientId: string, account: string): Promise<string> {
  const request = { method: "POST", url: "https://www.googleapis.com/drive/v3/files/sweep-file-1/permissions", query: {}, body: { role: "reader", type: "anyone" } };
  const step = await gatedStep({ step: "s1", fn: "drive.permissions.create", account, reason: "public-share", request, sentBody: JSON.stringify(request.body), incomplete: false });
  const deps = { links: env.CACHE_KV, baseUrl: BASE, auth: { userId, clientId }, executeId: "e-sweep", now: Date.now() };
  const { link } = await mintApprovalLink(deps, { planHash: "0".repeat(64), steps: [step] });
  return new URL(link.url).searchParams.get("t") ?? "";
}

/**
 * A user with a default account named "personal" (Gmail, Drive), a second named "work" that needs
 * reconnecting, a third connected and not yet allowed, and one approved AI app allowed only "personal". A
 * second user has just signed in: one account, no AI app.
 */
async function fixture() {
  const personal = await seedUserWithAccount(env, { email: uniqueEmail("sweep-a"), scopes: GMAIL_DRIVE, isDefault: true, alias: "Personal" });
  const userId = personal.userId;
  // The swept user is an admin of the access list, so the admin-only area and its nav item are swept too.
  await openAccessStore(env.DB).add({ pattern: personal.account.email, role: "admin", note: "Sweep owner" }, { actor: userId, via: "web" });
  const work = (await seedUserWithAccount(env, { email: uniqueEmail("sweep-b"), scopes: TASKS, userId, alias: "Work" })).account;
  // Google Ads connected, so its section on the account page is swept too.
  const spare = (await seedUserWithAccount(env, { email: uniqueEmail("sweep-c"), scopes: [...GMAIL_DRIVE, ...SERVICE_SCOPES[preset].ads], userId })).account;
  const browser = new Browser();
  const signedIn = await loginCallback(browser, personal.account.email);
  const app = await approveClient(browser, APP_NAME, (form) => form.accounts.filter((a) => a.id === personal.account.id).map((a) => a.id));
  await store.accounts.markStatus(userId, work.id, "reconnect");
  const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/accounts")).text())?.[1] ?? "";

  const fresh = await seedUserWithAccount(env, { email: uniqueEmail("sweep-new"), scopes: GMAIL_DRIVE, isDefault: true });
  const freshBrowser = new Browser();
  await loginCallback(freshBrowser, fresh.account.email);

  return {
    userId,
    browser,
    csrf,
    signedIn,
    app,
    personal: personal.account,
    work,
    spare,
    freshBrowser,
    allow: [personal.account.email, work.email, spare.email, fresh.account.email, "personal", "work", APP_NAME, "Sweep owner"],
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const id = (s: string) => encodeURIComponent(s);

interface PageCase {
  name: string;
  open: (fx: Fixture) => Promise<Response>;
  status: number;
  labels: (fx: Fixture) => readonly string[];
  /** How the page policy is sent: alone, or (sign-in and consent routes) appended to the provider's own policy. */
  csp: "page" | "consent";
  /** The page holds the connection help block. */
  help?: boolean;
}

const nav = [COPY.nav.home, COPY.nav.accounts, COPY.nav.apps, COPY.shell.signOut];

const PAGES: readonly PageCase[] = [
  {
    name: "who can use this",
    open: (fx) => fx.browser.fetch("/access"),
    status: 200,
    csp: "page",
    labels: () => [
      ...nav,
      ACCESS_COPY.nav,
      ACCESS_COPY.lede,
      ACCESS_COPY.adminsNote,
      ACCESS_COPY.moreAccounts,
      ACCESS_COPY.roles.admin,
      ACCESS_COPY.kinds.domain,
      ACCESS_COPY.makeUser,
      ACCESS_COPY.remove,
      ACCESS_COPY.removeHint,
      ACCESS_COPY.patternLabel,
      ACCESS_COPY.roleOptions.admin,
      ACCESS_COPY.add,
    ],
  },
  {
    name: "message: sign-in refused, private",
    open: async () => {
      const email = `outsider-${crypto.randomUUID().slice(0, 8)}@sweep-outsider.test`;
      await seedGoogle(email);
      return loginCallback(new Browser(), email);
    },
    status: 403,
    csp: "consent",
    labels: () => [PRIVATE_TITLE, PRIVATE_MESSAGE],
  },
  {
    name: "Home",
    open: (fx) => fx.browser.fetch("/"),
    status: 200,
    csp: "page",
    help: true,
    labels: () => [
      ...nav,
      HOME_COPY.title,
      HOME_COPY.attention(1),
      `${COPY.actions.reconnect} <bdi>work</bdi>`,
      HOME_COPY.connectedCount(2),
      HOME_COPY.approvedCount(1),
      COPY.actions.viewAccounts,
      COPY.actions.addGoogleAccount,
      COPY.actions.manageAiApps,
      HOME_COPY.stopTitle,
      connectAppHelp(CONNECTOR).title,
    ],
  },
  {
    name: "Home, just signed in with no AI app",
    open: (fx) => fx.freshBrowser.fetch("/"),
    status: 200,
    csp: "page",
    help: true,
    labels: () => [...nav, HOME_COPY.title, HOME_COPY.connectedCount(1), HOME_COPY.approvedCount(0), HOME_COPY.noAppsYet, HOME_COPY.stopTitle],
  },
  {
    name: "sign-in screen",
    open: () => new Browser().fetch("/"),
    status: 200,
    csp: "page",
    labels: () => [SIGN_IN_COPY.title, SIGN_IN_COPY.lede, SIGN_IN_COPY.firstAccount, COPY.actions.continueWithGoogle, 'href="/login"'],
  },
  {
    name: "Google accounts",
    open: (fx) => fx.browser.fetch("/accounts"),
    status: 200,
    csp: "page",
    labels: () => [...nav, COPY.status.active, COPY.status.reconnect, COPY.chips.default, "Allowed for:", COPY.actions.manageAccount, COPY.actions.reconnect, "Add another Google account"],
  },
  {
    name: "account details",
    open: (fx) => fx.browser.fetch(`/accounts/${id(fx.personal.id)}`),
    status: 200,
    csp: "page",
    labels: () => [...nav, GLOSSARY.accountName.term, COPY.actions.saveName, GLOSSARY.defaultAccount.term, GLOSSARY.googleServices.term, COPY.actions.addGoogleServices, "AI apps that can use", COPY.actions.disconnectAccount],
  },
  {
    name: "account details, refused name",
    open: (fx) => post(fx.browser, `/accounts/${id(fx.personal.id)}/name`, [["csrf", fx.csrf], ["alias", "a@b"]]),
    status: 400,
    csp: "page",
    labels: () => [...nav, GLOSSARY.accountName.term, "Use up to 64 characters", COPY.actions.saveName],
  },
  {
    name: "account details, Google Ads",
    open: (fx) => fx.browser.fetch(`/accounts/${id(fx.spare.id)}`),
    status: 200,
    csp: "page",
    labels: () => [...nav, ADS_COPY.title, ADS_COPY.lede, ADS_COPY.missing, ADS_COPY.codeLabel, ADS_COPY.codeHint, ADS_COPY.managerLabel, ADS_COPY.save],
  },
  {
    name: "account details, refused Google Ads details",
    open: (fx) => post(fx.browser, `/accounts/${id(fx.spare.id)}/ads`, [["csrf", fx.csrf], ["developerCode", "not a code"], ["managerId", ""]]),
    status: 400,
    csp: "page",
    labels: () => [...nav, ADS_COPY.title, "Copy the whole code from the API Center.", ADS_COPY.save],
  },
  {
    name: "add Google services",
    open: (fx) => fx.browser.fetch(`/accounts/${id(fx.personal.id)}/services`),
    status: 200,
    csp: "page",
    labels: () => [...nav, "Add Google services to", "Already connected", COPY.actions.continueToGoogle, COPY.actions.cancel],
  },
  {
    name: "add Google services, nothing chosen",
    open: (fx) => post(fx.browser, `/accounts/${id(fx.personal.id)}/services`, [["csrf", fx.csrf]]),
    status: 400,
    csp: "page",
    labels: () => [...nav, "Choose at least one Google service to add.", COPY.actions.continueToGoogle],
  },
  {
    name: "reconnect",
    open: (fx) => fx.browser.fetch(`/accounts/${id(fx.work.id)}/reconnect`),
    status: 200,
    csp: "page",
    labels: () => [...nav, `${COPY.actions.reconnect} <bdi>work</bdi>`, "needs permission from Google", COPY.actions.cancel],
  },
  {
    name: "confirm disconnect",
    open: (fx) => fx.browser.fetch(`/accounts/${id(fx.spare.id)}/disconnect`),
    status: 200,
    csp: "page",
    labels: (fx) => [...nav, `Disconnect ${fx.spare.email}?`, "What stops", "What stays", COPY.trust.googleDataNotDeleted, COPY.actions.cancel],
  },
  {
    name: "AI apps",
    open: (fx) => fx.browser.fetch("/apps"),
    status: 200,
    csp: "page",
    labels: () => [...nav, APP_NAME, COPY.chips.approved, COPY.actions.manageAccess],
  },
  {
    name: "AI apps, none approved yet",
    open: (fx) => fx.freshBrowser.fetch("/apps"),
    status: 200,
    csp: "page",
    help: true,
    labels: () => [...nav, COPY.empty.noApps, connectAppHelp(CONNECTOR).title],
  },
  {
    name: "AI app details",
    open: (fx) => fx.browser.fetch(`/apps/${id(fx.app.clientId)}`),
    status: 200,
    csp: "page",
    labels: () => [...nav, "Allowed Google accounts", COPY.actions.saveChanges, COPY.actions.cancel, COPY.trust.writeGuard, COPY.actions.removeAiApp],
  },
  {
    name: "AI app details, out of date",
    open: (fx) => post(fx.browser, `/apps/${id(fx.app.clientId)}/access`, [["csrf", fx.csrf], ["shown", ""], ["account", fx.personal.id]]),
    status: 409,
    csp: "page",
    labels: () => [...nav, "This page was out of date. Review and save again.", COPY.actions.saveChanges],
  },
  {
    name: "AI app details, account not connected",
    open: (fx) => post(fx.browser, `/apps/${id(fx.app.clientId)}/access`, [["csrf", fx.csrf], ["shown", fx.personal.id], ["account", fx.personal.id], ["account", fx.work.id]]),
    status: 400,
    csp: "page",
    labels: () => [...nav, "Only connected accounts can be newly allowed.", COPY.actions.saveChanges],
  },
  {
    name: "confirm removing an AI app",
    open: (fx) => fx.browser.fetch(`/apps/${id(fx.app.clientId)}/remove`),
    status: 200,
    csp: "page",
    labels: () => [...nav, `Remove ${APP_NAME}?`, "What stops", "What stays", COPY.trust.googleDataNotDeleted, COPY.actions.cancel],
  },
  {
    name: "approve an AI app",
    open: async (fx) => {
      const clientId = await registerClient(APP_NAME);
      const { challenge } = await pkce();
      return fx.browser.fetch(authorizePath(clientId, challenge, crypto.randomUUID()));
    },
    status: 200,
    csp: "consent",
    labels: () => ["Choose Google accounts", "What you're allowing", CAPABILITIES_TEXT, COPY.trust.writeGuard, COPY.actions.allowSelected, COPY.actions.dontAllow],
  },
  {
    name: "confirm one more account for an AI app",
    open: async (fx) => fx.browser.fetch(`/connections/confirm?t=${await grantLink(fx.userId, fx.app.clientId)}`),
    status: 200,
    csp: "page",
    labels: () => ["Choose a Google account", "Allow selected account", COPY.actions.dontAllow, COPY.trust.writeGuard],
  },
  {
    name: "message: not found",
    open: (fx) => fx.browser.fetch("/accounts/a_nope"),
    status: 404,
    csp: "page",
    labels: () => ["Not found", "This page doesn't exist, or it isn't one of yours."],
  },
  {
    name: "message: action without a session",
    open: (fx) => post(new Browser(), `/apps/${id(fx.app.clientId)}/access`, [["csrf", fx.csrf]]),
    status: 401,
    csp: "page",
    labels: () => ["Signed out", "Sign in and try again."],
  },
  {
    name: "message: form from another site",
    open: (fx) => post(fx.browser, `/accounts/${id(fx.personal.id)}/name`, [["csrf", fx.csrf], ["alias", "x"]], "https://evil.example"),
    status: 403,
    csp: "page",
    labels: () => ["Request refused", "This form did not come from this site."],
  },
  {
    name: "message: link not valid",
    open: (fx) => fx.browser.fetch("/connections/confirm?t=nope"),
    status: 400,
    csp: "page",
    labels: () => ["Link not valid", "Ask the app again."],
  },
  {
    name: "set a setting from a one-time link",
    open: async (fx) => fx.browser.fetch(`/settings/set?t=${await settingLink(fx.userId, fx.app.clientId, "ads.developer_token")}`),
    status: 200,
    csp: "page",
    labels: () => [...nav, "Set your Google Ads developer code", SETTING_LINK_COPY.lede, SETTING_LINK_COPY.appliesToAll, ADS_COPY.codeLabel, ADS_COPY.codeHint, SETTING_LINK_COPY.once, COPY.actions.cancel],
  },
  {
    name: "set a setting from a one-time link, refused value",
    open: async (fx) => post(fx.browser, "/settings/set", [["csrf", fx.csrf], ["t", await settingLink(fx.userId, fx.app.clientId, "ads.developer_token")], ["value", "not a code"]]),
    status: 400,
    csp: "page",
    labels: () => [...nav, "Set your Google Ads developer code", "Copy the whole code from the API Center."],
  },
  {
    name: "message: one-time link not valid",
    open: (fx) => fx.browser.fetch("/settings/set?t=nope"),
    status: 400,
    csp: "page",
    labels: () => [SETTING_LINK_COPY.invalidTitle, SETTING_LINK_COPY.invalid],
  },
  {
    name: "message: one-time link for someone else (the same as not valid)",
    open: async (fx) => fx.freshBrowser.fetch(`/settings/set?t=${await settingLink(fx.userId, fx.app.clientId, "ads.developer_token")}`),
    status: 400,
    csp: "page",
    labels: () => [SETTING_LINK_COPY.invalidTitle, SETTING_LINK_COPY.invalid],
  },
  {
    name: "message: one-time link saved",
    open: async (fx) =>
      post(fx.browser, "/settings/set", [["csrf", fx.csrf], ["t", await settingLink(fx.userId, fx.app.clientId, "ads.login_customer_id")], ["value", "123-456-7890"]]),
    status: 200,
    csp: "page",
    labels: () => [SETTING_LINK_COPY.savedTitle, SETTING_LINK_COPY.saved("Google Ads manager account ID")],
  },
  {
    name: "approve what an AI app wants to do, from a one-time link",
    open: async (fx) => fx.browser.fetch(`/plan/approve?t=${await approvalLink(fx.userId, fx.app.clientId, fx.personal.email)}`),
    status: 200,
    csp: "page",
    labels: () => [
      ...nav,
      APPROVAL_LINK_COPY.title,
      APPROVAL_LINK_COPY.lede,
      "Makes something visible to anyone",
      APPROVAL_LINK_COPY.account,
      APPROVAL_LINK_COPY.sends,
      APPROVAL_LINK_COPY.approve,
      APPROVAL_LINK_COPY.decline,
      APPROVAL_LINK_COPY.once,
    ],
  },
  {
    name: "message: approved from a one-time link",
    open: async (fx) => post(fx.browser, "/plan/approve", [["csrf", fx.csrf], ["t", await approvalLink(fx.userId, fx.app.clientId, fx.personal.email)], ["decision", "approve"]]),
    status: 200,
    csp: "page",
    labels: () => [APPROVAL_LINK_COPY.approvedTitle, APPROVAL_LINK_COPY.approved],
  },
  {
    name: "message: declined from a one-time link",
    open: async (fx) => post(fx.browser, "/plan/approve", [["csrf", fx.csrf], ["t", await approvalLink(fx.userId, fx.app.clientId, fx.personal.email)], ["decision", "decline"]]),
    status: 200,
    csp: "page",
    labels: () => [APPROVAL_LINK_COPY.declinedTitle, APPROVAL_LINK_COPY.declined],
  },
  {
    name: "message: approval link not valid, or someone else's",
    open: async (fx) => fx.freshBrowser.fetch(`/plan/approve?t=${await approvalLink(fx.userId, fx.app.clientId, fx.personal.email)}`),
    status: 400,
    csp: "page",
    labels: () => [APPROVAL_LINK_COPY.invalidTitle, APPROVAL_LINK_COPY.invalid],
  },
  {
    name: "message: approval without a choice",
    open: async (fx) => post(fx.browser, "/plan/approve", [["csrf", fx.csrf], ["t", "nope"]]),
    status: 400,
    csp: "page",
    labels: () => [APPROVAL_LINK_COPY.choiceTitle, APPROVAL_LINK_COPY.choice],
  },
  {
    name: "message: Google sign-in failed",
    open: () => new Browser().fetch("/google/callback?state=nope&code=nope"),
    status: 400,
    csp: "consent",
    labels: () => ["Sign-in failed", "Start again."],
  },
  {
    name: "message: AI app request not valid",
    open: () => new Browser().fetch("/authorize?response_type=code&client_id=nope"),
    status: 400,
    csp: "consent",
    labels: () => ["Invalid request", "Start again from your app."],
  },
  {
    name: "message: signed out",
    open: async () => {
      const b = new Browser();
      const email = uniqueEmail("sweep-out");
      await seedUserWithAccount(env, { email, scopes: GMAIL_DRIVE });
      await loginCallback(b, email);
      const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await b.fetch("/accounts")).text())?.[1] ?? "";
      return post(b, "/logout", [["csrf", csrf]]);
    },
    status: 200,
    csp: "consent",
    labels: () => ["Signed out", "You are signed out of gws-mcp."],
  },
];

describe("plain-language sweep", () => {
  it("lands a returning sign-in on Home", async () => {
    const fx = await fixture();
    expect(fx.signedIn.status).toBe(302);
    expect(fx.signedIn.headers.get("location")).toBe(DEFAULT_NEXT);
    expect(DEFAULT_NEXT).toBe("/");
  });

  it("serves every page in plain words, with its key labels and its security policy", async () => {
    const fx = await fixture();
    for (const p of PAGES) {
      const res = await p.open(fx);
      const page = await res.text();
      expect([p.name, res.status]).toEqual([p.name, p.status]);
      expect([p.name, res.headers.get("content-type")]).toEqual([p.name, expect.stringContaining("text/html")]);
      const csp = res.headers.get("content-security-policy") ?? "";
      // The sign-in and consent routes append the page policy to the provider's own frame-ancestors policy.
      if (p.csp === "page") expect([p.name, csp]).toEqual([p.name, PAGE_CSP]);
      else expect([p.name, csp.endsWith(PAGE_CSP)]).toEqual([p.name, true]);
      for (const label of p.labels(fx)) expect([p.name, label, decode(page).includes(label)]).toEqual([p.name, label, true]);
      expect([p.name, page.includes("data-help")]).toEqual([p.name, p.help === true]);
      try {
        expectPlainLanguage(page, { allow: fx.allow, connectorUrl: CONNECTOR });
      } catch (e) {
        throw new Error(`${p.name}: ${(e as Error).message}`);
      }
    }
    // About 25 full page loads with sign-ins: more than the default 5 s budget on a loaded machine.
  }, 30_000);

  it("shows Home's attention banner only for accounts that need reconnecting, each linking to its reconnect page", async () => {
    const fx = await fixture();
    const page = await (await fx.browser.fetch("/")).text();
    const attention = /<section class="flash flash-warning"[^>]*>([\s\S]*?)<\/section>/.exec(page)?.[1] ?? "";
    expect(attention).toContain(`href="/accounts/${id(fx.work.id)}/reconnect"`);
    expect(attention).not.toContain(fx.personal.id);
    expect(attention).not.toContain(fx.spare.id);
    expect(page).toContain('href="/apps"');
    expect(page).toContain(`href="/apps/${id(fx.app.clientId)}"`);
    expect(page).toContain(`${HOME_COPY.allowed} <bdi>personal</bdi>`);
    // Adding a Google account starts the existing connect flow for the one-click services.
    expect(page).toMatch(
      new RegExp(
        `<form method="post" action="/connections/connect" class="inline"><input type="hidden" name="csrf" value="[^"]+">${DEFAULT_CONNECT_SERVICES.map((s) => `<input type="hidden" name="service" value="${s}">`).join("")}<button`,
      ),
    );
    const freshHome = await (await fx.freshBrowser.fetch("/")).text();
    expect(freshHome).not.toContain('class="flash flash-warning"');
  });
});

/** Pages that show a flash; each is told a different error happened to the account "work". */
const FLASH_PAGES: ReadonlyArray<[string, (fx: Fixture) => string]> = [
  ["Home", () => "/"],
  ["Google accounts", () => "/accounts"],
  ["account details", (fx) => `/accounts/${id(fx.work.id)}`],
  ["add Google services", (fx) => `/accounts/${id(fx.work.id)}/services`],
  ["reconnect", (fx) => `/accounts/${id(fx.work.id)}/reconnect`],
  ["confirm disconnect", (fx) => `/accounts/${id(fx.work.id)}/disconnect`],
  ["AI apps", () => "/apps"],
  ["AI app details", (fx) => `/apps/${id(fx.app.clientId)}`],
  ["confirm removing an AI app", (fx) => `/apps/${id(fx.app.clientId)}/remove`],
  ["who can use this", () => "/access"],
];

/** Stores `flash` for the browser's next page through the real flash module, as a POST handler would. */
async function plantFlash(browser: Browser, userId: string, flash: Flash): Promise<void> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", async (c) => {
    await setFlash(c, userId, flash);
    return c.body(null, 204);
  });
  const res = await app.request("/", {}, env);
  const [pair = ""] = res.headers.getSetCookie()[0]?.split(";") ?? [];
  browser.cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
}

describe("errors in plain words", () => {
    // Google's own error names first, then the server's codes.
  const codes = [...PLAIN_ERROR_CODES.filter((c) => !c.startsWith("GWS_")), ...PLAIN_ERROR_CODES.filter((c) => c.startsWith("GWS_"))];

  it("words a failed action on every page through plainError, never as its code", async () => {
    const fx = await fixture();
    expect(codes.length).toBeGreaterThanOrEqual(FLASH_PAGES.length);
    for (const [i, [name, path]] of FLASH_PAGES.entries()) {
      const code = codes[i] ?? "";
      await plantFlash(fx.browser, fx.userId, { tone: "error", kind: "error", code, accountId: fx.work.id });
      const page = await (await fx.browser.fetch(path(fx))).text();
      expect([name, banner(page)]).toEqual([name, { role: "alert", text: plainError(code, "work") }]);
      expect([name, code, page.includes(code)]).toEqual([name, code, false]);
      expectPlainLanguage(page, { allow: fx.allow, connectorUrl: CONNECTOR });
    }
  });

  it("words the access list's own results and refusals in plain words", async () => {
    const fx = await fixture();
    const cases: Array<[Flash, string]> = [
      [{ tone: "success", kind: "access-saved" }, ACCESS_COPY.saved],
      [{ tone: "success", kind: "access-removed" }, ACCESS_COPY.removed],
      [{ tone: "warning", kind: "access-removed", code: "cleanup_incomplete" }, ACCESS_COPY.removedPartly],
      [{ tone: "error", kind: "error", code: "last_admin" }, ACCESS_COPY.lastAdmin],
      [{ tone: "error", kind: "error", code: "bad_pattern" }, ACCESS_COPY.badPattern],
      [{ tone: "error", kind: "error", code: "conflict" }, ACCESS_COPY.conflict],
    ];
    for (const [flash, text] of cases) {
      await plantFlash(fx.browser, fx.userId, flash);
      const page = await (await fx.browser.fetch("/access")).text();
      expect(banner(page)?.text).toBe(text);
      if (flash.code !== undefined) expect(page).not.toContain(flash.code);
      expectPlainLanguage(page, { allow: fx.allow });
    }
  });

  it("words an unknown code and a missing account generically, never echoing either", async () => {
    const fx = await fixture();
    await plantFlash(fx.browser, fx.userId, { tone: "error", kind: "error", code: "SOMETHING_NEW", accountId: "a_not_theirs" });
    const page = await (await fx.browser.fetch("/")).text();
    expect(banner(page)).toEqual({ role: "alert", text: plainError("SOMETHING_NEW") });
    expect(page).not.toContain("SOMETHING_NEW");
    expect(page).not.toContain("a_not_theirs");
  });
});

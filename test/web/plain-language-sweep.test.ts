import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CAPABILITIES_TEXT } from "../../src/auth/consent-page";
import { DEFAULT_NEXT } from "../../src/auth/google-flow";
import { SERVICE_SCOPES } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { openStore } from "../../src/store/db";
import { COPY, GLOSSARY, PLAIN_ERROR_CODES, connectAppHelp, plainError } from "../../src/web/copy";
import { setFlash, type Flash } from "../../src/web/flash";
import { HOME_COPY, SIGN_IN_COPY } from "../../src/web/pages/home";
import { PAGE_CSP } from "../../src/web/ui";
import { fakeTransport, seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, approveClient, authorizePath, config, loginCallback, pkce, registerClient } from "../auth/browser";
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

/**
 * A user with a default account named "personal" (Gmail, Drive), a second named "work" that needs
 * reconnecting, a third connected and not yet allowed, and one approved AI app allowed only "personal". A
 * second user has just signed in: one account, no AI app.
 */
async function fixture() {
  const personal = await seedUserWithAccount(env, { email: uniqueEmail("sweep-a"), scopes: GMAIL_DRIVE, isDefault: true, alias: "Personal" });
  const userId = personal.userId;
  const work = (await seedUserWithAccount(env, { email: uniqueEmail("sweep-b"), scopes: TASKS, userId, alias: "Work" })).account;
  const spare = (await seedUserWithAccount(env, { email: uniqueEmail("sweep-c"), scopes: GMAIL_DRIVE, userId })).account;
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
    allow: [personal.account.email, work.email, spare.email, fresh.account.email, "personal", "work", APP_NAME],
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
  });

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
    // Adding a Google account starts the existing connect flow for every service.
    expect(page).toMatch(/<form method="post" action="\/connections\/connect" class="inline"><input type="hidden" name="csrf" value="[^"]+">(<input type="hidden" name="service" value="[a-z]+">){8}<button/);
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

  it("words an unknown code and a missing account generically, never echoing either", async () => {
    const fx = await fixture();
    await plantFlash(fx.browser, fx.userId, { tone: "error", kind: "error", code: "SOMETHING_NEW", accountId: "a_not_theirs" });
    const page = await (await fx.browser.fetch("/")).text();
    expect(banner(page)).toEqual({ role: "alert", text: plainError("SOMETHING_NEW") });
    expect(page).not.toContain("SOMETHING_NEW");
    expect(page).not.toContain("a_not_theirs");
  });
});

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CAPABILITIES_TEXT } from "../../src/auth/consent-page";
import { STYLESHEET } from "../../src/web/ui";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import {
  Browser,
  CLIENT_REDIRECT,
  approveClient,
  authorizePath,
  defaultAccount,
  exchangeCode,
  grantRows,
  mcpToolsList,
  parseConsent,
  pkce,
  registerClient,
  seedGoogle,
  signIn,
  userIdFor,
} from "./browser";

const G = "https://www.googleapis.com/auth/";
const HOSTILE_NAME = `<script>alert("x")</script> & 'Co'`;

/** A signed-in user with two accounts: A (default, from sign-in) and B (connected later). */
let browser: Browser;
let userId: string;
let emailA: string;
let emailB: string;
let accountA: string;
let accountB: string;

beforeAll(async () => {
  emailA = uniqueEmail("consent-a");
  emailB = uniqueEmail("consent-b");
  const sub = await seedGoogle(emailA);
  userId = userIdFor(sub);
  browser = new Browser();
  // Unauthenticated: /authorize sends the browser to /login with the request as `next`.
  const clientId = await registerClient("warm-up client");
  const { challenge } = await pkce();
  const path = authorizePath(clientId, challenge, "s0");
  const first = await browser.fetch(path);
  expect(first.status).toBe(302);
  expect(first.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
  const callback = await signIn(browser, emailA, path);
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(path);
  const accounts = await openStore(env).accounts.listForUser(userId);
  accountA = accounts[0]?.id ?? "";
  accountB = (await seedUserWithAccount(env, { email: emailB, scopes: [`${G}drive.file`], userId })).account.id;
});

interface Started {
  clientId: string;
  verifier: string;
  state: string;
  page: Response;
  html: string;
}

async function startConsent(name = "Test MCP client", who = browser): Promise<Started> {
  const clientId = await registerClient(name);
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();
  const page = await who.fetch(authorizePath(clientId, challenge, state));
  return { clientId, verifier, state, page, html: await page.text() };
}

function approve(handle: string, csrf: string, accountIds: string[], who = browser): Promise<Response> {
  return who.postForm("/authorize", [
    ["handle", handle],
    ["csrf", csrf],
    ["decision", "approve"],
    ...accountIds.map((id): [string, string] => ["account", id]),
  ]);
}

describe("unauthenticated MCP", () => {
  it("answers /mcp without a token with 401", async () => {
    expect(await mcpToolsList()).toBe(401);
  });
});

describe("consent page", () => {
  it("shows the escaped client name, redirect host, capabilities and the account checkboxes", async () => {
    const s = await startConsent(HOSTILE_NAME);
    expect(s.page.status).toBe(200);
    expect(s.html).not.toContain("<script");
    expect(s.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;");
    expect(s.html).toContain(new URL(CLIENT_REDIRECT).hostname);
    expect(s.html).toContain(CAPABILITIES_TEXT);
    const form = parseConsent(s.html);
    // Nothing is pre-checked: a stray click on Allow grants an empty allowlist.
    expect(form.accounts.map((a) => [a.id, a.checked])).toEqual([
      [accountA, false],
      [accountB, false],
    ]);
    expect(form.accounts[0]?.label).toContain(emailA);
    expect(form.accounts[1]?.label).toContain(emailB);
  });

  it("is not frameable or cacheable and binds its handle to this browser", async () => {
    const s = await startConsent();
    expect(s.page.headers.get("x-frame-options")).toBe("DENY");
    expect(s.page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(s.page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(s.page.headers.get("cache-control")).toContain("no-store");
    expect(browser.cookieNames("__Host-oauth-consent").length).toBeGreaterThan(0);
  });
});

describe("consent page accounts", () => {
  it("offers only active accounts, and refuses a disconnected or reconnect-state account if posted anyway", async () => {
    const store = openStore(env);
    const gone = (await seedUserWithAccount(env, { email: uniqueEmail("consent-gone"), scopes: [`${G}drive.file`], userId })).account;
    await store.accounts.wipeToken(userId, gone.id);
    const stale = (await seedUserWithAccount(env, { email: uniqueEmail("consent-stale"), scopes: [`${G}drive.file`], userId })).account;
    await store.accounts.markStatus(userId, stale.id, "reconnect");

    const s = await startConsent();
    const form = parseConsent(s.html);
    expect(form.accounts.map((a) => a.id)).toEqual([accountA, accountB]);
    expect(s.html).not.toContain(gone.email);
    expect(s.html).not.toContain(stale.email);
    for (const id of [gone.id, stale.id]) {
      const refused = await approve(form.handle, form.csrf, [id]);
      expect(refused.status).toBe(400);
      expect(refused.headers.get("location")).toBeNull();
    }
    expect(await grantRows(userId, s.clientId)).toEqual([]);
    expect((await approve(form.handle, form.csrf, [accountA])).status).toBe(302);
  });
});

describe("invalid authorization requests", () => {
  const broken: Array<[string, Record<string, string | null>]> = [
    ["an unsupported response_type", { response_type: "token" }],
    ["no PKCE challenge", { code_challenge: null, code_challenge_method: null }],
  ];

  it.each(broken)("with %s and no session, render an error page and never redirect to the client", async (_label, overrides) => {
    const clientId = await registerClient("Redirect probe");
    const { challenge } = await pkce();
    const res = await new Browser().fetch(authorizePath(clientId, challenge, "s", overrides));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it.each(broken)("with %s and a session, redirect the error to the registered client", async (_label, overrides) => {
    const clientId = await registerClient("Redirect probe");
    const { challenge } = await pkce();
    const res = await browser.fetch(authorizePath(clientId, challenge, "s", overrides));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("error")).not.toBeNull();
  });
});

describe("granted scope", () => {
  it.each([
    ["gws plus an unknown scope", "gws extra"],
    ["no scope", null],
  ])("is exactly gws when the client asks for %s", async (_label, scope) => {
    const client = await approveClient(browser, "Scope probe", defaultAccount, { scope });
    expect(client.scope).toBe("gws");
    expect(await mcpToolsList(client.accessToken)).toBe(200);
  });
});

describe("client names on the consent page", () => {
  it("strips bidi and control characters and caps a 50 KB name", async () => {
    const name = `Evil\u202Egnp.exe\u2066\u0007\u0085${"A".repeat(50_000)}`;
    const s = await startConsent(name);
    expect(s.page.status).toBe(200);
    expect(s.html).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
    // The shared stylesheet is a fixed size; the rest of the page must stay small whatever the name.
    expect(s.html.replace(STYLESHEET, "").length).toBeLessThan(6000);
    const shown = `Evilgnp.exe${"A".repeat(89)}`;
    expect(Array.from(shown)).toHaveLength(100);
    expect(s.html).toContain(shown);
    expect(s.html).not.toContain(`${shown}A`);
  });
});

describe("approving a client", () => {
  it("issues a code for the chosen account only, a working token, and exactly that allowlist", async () => {
    const s = await startConsent();
    const form = parseConsent(s.html);
    const res = await approve(form.handle, form.csrf, [accountA]);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("state")).toBe(s.state);
    const code = location.searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    const token = await exchangeCode(s.clientId, code, s.verifier);
    expect(token.status).toBe(200);
    const accessToken = ((await token.json()) as { access_token: string }).access_token;
    expect(await mcpToolsList(accessToken)).toBe(200);

    expect(await grantRows(userId, s.clientId)).toEqual([accountA]);
    const { results } = await env.DB.prepare("SELECT user_id, client_id, account_id FROM client_grants WHERE client_id = ?")
      .bind(s.clientId)
      .all();
    expect(results).toEqual([{ user_id: userId, client_id: s.clientId, account_id: accountA }]);
  });

  it("sets the allowlist to exactly the accounts ticked, both of them included", async () => {
    const s = await startConsent();
    const form = parseConsent(s.html);
    expect((await approve(form.handle, form.csrf, [accountB, accountA])).status).toBe(302);
    expect(await grantRows(userId, s.clientId)).toEqual([accountA, accountB].sort());
  });

  it("refuses an account that is not the user's, before using up the page", async () => {
    const other = await seedUserWithAccount(env, { email: uniqueEmail("consent-foreign"), scopes: [`${G}drive.file`] });
    const s = await startConsent();
    const form = parseConsent(s.html);
    const refused = await approve(form.handle, form.csrf, [accountA, other.account.id]);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("location")).toBeNull();
    expect(await grantRows(userId, s.clientId)).toEqual([]);
    expect((await approve(form.handle, form.csrf, [accountA])).status).toBe(302);
    expect(await grantRows(userId, s.clientId)).toEqual([accountA]);
  });

  it("refuses a post without the session's CSRF token", async () => {
    const s = await startConsent();
    const form = parseConsent(s.html);
    for (const csrf of ["", "x".repeat(43)]) {
      const res = await approve(form.handle, csrf, [accountA]);
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(await grantRows(userId, s.clientId)).toEqual([]);
  });

  it("refuses an approval without the consent page's binding cookie", async () => {
    const s = await startConsent();
    const form = parseConsent(s.html);
    const cookieless = new Browser();
    for (const [name, value] of browser.cookies) if (!name.startsWith("__Host-oauth-consent")) cookieless.cookies.set(name, value);
    const res = await approve(form.handle, form.csrf, [accountA], cookieless);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await grantRows(userId, s.clientId)).toEqual([]);
  });

  it("refuses an approval without a session", async () => {
    const s = await startConsent();
    const form = parseConsent(s.html);
    const anonymous = new Browser();
    for (const [name, value] of browser.cookies) if (name !== "__Host-gws_session") anonymous.cookies.set(name, value);
    const res = await approve(form.handle, form.csrf, [accountA], anonymous);
    expect(res.status).toBe(401);
    expect(await grantRows(userId, s.clientId)).toEqual([]);
  });

  it("redirects a denial to the client with error=access_denied and grants nothing", async () => {
    const s = await startConsent();
    const form = parseConsent(s.html);
    const res = await browser.postForm("/authorize", [
      ["handle", form.handle],
      ["csrf", form.csrf],
      ["decision", "deny"],
      ["account", accountA],
    ]);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(s.state);
    expect(location.searchParams.get("code")).toBeNull();
    expect(await grantRows(userId, s.clientId)).toEqual([]);
  });
});

describe("signing out", () => {
  it("needs the CSRF token, then ends the session", async () => {
    const email = uniqueEmail("logout");
    await seedGoogle(email);
    const b = new Browser();
    await signIn(b, email);
    const csrf = parseConsent((await startConsent("logout client", b)).html).csrf;
    expect((await b.postForm("/logout", [["csrf", "wrong"]])).status).toBe(403);
    expect(b.cookies.has("__Host-gws_session")).toBe(true);
    const out = await b.postForm("/logout", [["csrf", csrf]]);
    expect(out.status).toBe(200);
    expect(b.cookies.has("__Host-gws_session")).toBe(false);
    const again = await startConsent("after logout", b);
    expect(again.page.status).toBe(302);
    expect(again.page.headers.get("location")?.startsWith("/login?next=")).toBe(true);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CAPABILITIES_TEXT, renderConsentPage, type ConsentPageInput } from "../../src/auth/consent-page";
import { openStore } from "../../src/store/db";
import { COPY } from "../../src/web/copy";
import { STYLESHEET } from "../../src/web/ui";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { expectPlainLanguage } from "../web/plain-language";
import { Browser, CLIENT_REDIRECT, authorizePath, defaultAccount, grantRows, parseConsent, pkce, registerClient, seedGoogle, signIn, userIdFor } from "./browser";

const HOSTILE = `<img src=x onerror=alert(1)> & "Co"`;
const HOSTILE_ESCAPED = "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;";

/** `text` as the pages render it (HTML-escaped). */
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const input = (over: Partial<ConsentPageInput> = {}): ConsentPageInput => ({
  clientName: "Helper",
  redirectHost: "app.example",
  redirectIsLoopback: false,
  scope: ["gws"],
  accounts: [
    { id: "a_1", email: "me@x.test", isDefault: true },
    { id: "a_2", email: "w@x.test", alias: "work", isDefault: false },
  ],
  handle: "h1",
  csrf: "tok",
  ...over,
});

describe("approve page", () => {
  it("asks to allow the app by its escaped, unverified name, with nothing selected", async () => {
    const page = await renderConsentPage(input({ clientName: HOSTILE }));
    expect(page).not.toContain("<img");
    expect(page).toContain(`<h1 class="title">Allow <bdi>${HOSTILE_ESCAPED}</bdi> to use your Google accounts?</h1>`);
    expect(page).toContain(esc(COPY.trust.appNameNotVerified));
    expect(page).toContain(`<style>${STYLESHEET}</style>`);
    expect(parseConsent(page).accounts).toEqual([
      { id: "a_1", label: "me@x.test (default)", checked: false },
      { id: "a_2", label: "w@x.test", checked: false },
    ]);
    expect(page).not.toMatch(/name="account"[^>]* checked/);
  });

  it("keeps the form exactly: action, handle, CSRF, account fields and the two decisions", async () => {
    const page = await renderConsentPage(input());
    expect(page).toContain('<form method="post" action="/authorize">\n<input type="hidden" name="handle" value="h1">\n<input type="hidden" name="csrf" value="tok">');
    expect(page.match(/<form /g)).toHaveLength(1);
    expect(page).toContain(`<button type="submit" name="decision" value="approve" class="btn btn-primary">${COPY.actions.allowSelected}</button>`);
    expect(page).toContain(`<button type="submit" name="decision" value="deny" class="btn btn-ghost">${esc(COPY.actions.dontAllow)}</button>`);
    expect(parseConsent(page)).toMatchObject({ handle: "h1", csrf: "tok" });
  });

  it("shows each account's status, the plain write guard, where access goes and what no choice means", async () => {
    const page = await renderConsentPage(input());
    expect(page.match(new RegExp(`<span class="chip chip-ok">${COPY.status.active}</span>`, "g"))).toHaveLength(2);
    expect(page).toContain(esc(CAPABILITIES_TEXT));
    expect(page).toContain(esc(COPY.trust.writeGuard));
    expect(page).toContain("<p>Access goes to <strong>app.example</strong>.</p>");
    expect(page).toContain(esc(COPY.trust.appStaysApprovedWithoutAccounts("Helper")));
    expect(page).not.toContain("on your computer");
    expectPlainLanguage(page, { allow: ["Helper", "me@x.test", "w@x.test", "work", "app.example"] });
  });

  it("warns when access goes to an app on this computer, and says when there is no account to choose", async () => {
    const page = await renderConsentPage(input({ redirectIsLoopback: true, redirectHost: "127.0.0.1:3000", accounts: [] }));
    expect(page).toContain("on your computer");
    expect(page).toContain(esc(COPY.empty.noAccounts));
    expect(parseConsent(page).accounts).toEqual([]);
    expectPlainLanguage(page, { allow: ["Helper", "127.0.0.1:3000"] });
  });
});

describe("approve page account names", () => {
  it("leads with the email and shows the account name cleaned and isolated, outside the label", async () => {
    const page = await renderConsentPage(
      input({
        accounts: [
          { id: "a_1", email: "me@x.test", alias: "\u202Epersonal\uFF20gmail.com", isDefault: false },
          { id: "a_2", email: "w@x.test", alias: "x) (default", isDefault: false },
        ],
      }),
    );
    expect(page).not.toContain("\u202E");
    expect(page).toContain('<label><input type="checkbox" name="account" value="a_1"> me@x.test</label> <bdi>personal\uFF20gmail.com</bdi>');
    const form = parseConsent(page);
    expect(form.accounts.map((a) => a.label)).toEqual(["me@x.test", "w@x.test"]);
    // A name can't pass itself off as the default account.
    expect(defaultAccount(form)).toEqual([]);
  });
});

describe("approve page in the flow", () => {
  it("is served at /authorize in plain words, and approves exactly the chosen accounts", async () => {
    const email = uniqueEmail("approve-flow-a");
    const userId = userIdFor(await seedGoogle(email));
    const browser = new Browser();
    await signIn(browser, email);
    const other = (await seedUserWithAccount(env, { email: uniqueEmail("approve-flow-b"), scopes: ["https://www.googleapis.com/auth/drive.file"], userId })).account;
    const clientId = await registerClient("Flow helper");
    const { challenge } = await pkce();
    const res = await browser.fetch(authorizePath(clientId, challenge, "s1"));
    expect(res.status).toBe(200);
    const page = await res.text();
    const form = parseConsent(page);
    expect(form.accounts.map((a) => a.checked)).toEqual([false, false]);
    expect(defaultAccount(form)).toHaveLength(1);
    expectPlainLanguage(page, { allow: ["Flow helper", email, other.email, new URL(CLIENT_REDIRECT).host] });

    const approved = await browser.postForm("/authorize", [
      ["handle", form.handle],
      ["csrf", form.csrf],
      ["decision", "approve"],
      ["account", other.id],
    ]);
    expect(approved.status).toBe(302);
    expect(await grantRows(userId, clientId)).toEqual([other.id]);
    expect((await openStore(env).accounts.listForUser(userId)).length).toBe(2);
  });
});

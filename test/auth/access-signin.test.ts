import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { admitSignIn, forgetAccessCache } from "../../src/auth/access";
import { PRIVATE_MESSAGE } from "../../src/auth/routes";
import { sha256Hex } from "../../src/auth/session";
import { openAccessStore } from "../../src/store/access";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, authorizePath, loginCallback, parseConsent, pickAtFake, pkce, redirectsToGoogle, registerClient, seedGoogle, signIn } from "./browser";

/**
 * Sign-in against the access list. The test setup allows @fake.test and @example.test as users; every deny case uses
 * an email outside those domains, including lookalikes of them.
 */

const access = openAccessStore(env.DB);
const ADMIN = { actor: "u_test-admin", via: "web" as const };

async function sessionUser(browser: Browser): Promise<string | null> {
  const id = browser.cookies.get("__Host-gws_session");
  if (!id) return null;
  const raw = await env.CACHE_KV.get(`sess:${await sha256Hex(id)}`);
  return raw ? (JSON.parse(raw) as { userId: string }).userId : null;
}

async function userCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? 0;
}

function unique(local: string, domain: string): string {
  return `${local}-${crypto.randomUUID().slice(0, 8)}@${domain}`;
}

async function expectPrivate(res: Response, browser: Browser): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.text()).toContain(PRIVATE_MESSAGE);
  expect(browser.cookies.has("__Host-gws_session")).toBe(false);
}

describe("sign-in against the access list", () => {
  beforeEach(() => forgetAccessCache());

  it("refuses an email no rule allows: the private page, no session and no user created", async () => {
    const email = unique("stranger", "outsider.test");
    await seedGoogle(email);
    const before = await userCount();
    const browser = new Browser();
    await expectPrivate(await loginCallback(browser, email), browser);
    expect(await userCount()).toBe(before);
  });

  it("refuses lookalikes of an allowed domain: a longer name ending the same way, a subdomain, a suffix", async () => {
    for (const email of [unique("x", "evil-fake.test"), unique("a", "sub.fake.test"), unique("a", "fake.test-evil.test")]) {
      await seedGoogle(email);
      const browser = new Browser();
      await expectPrivate(await loginCallback(browser, email), browser);
    }
  });

  it("allows an email of an allowed domain, whatever its case", async () => {
    const email = uniqueEmail("domain-ok");
    await seedGoogle(email);
    const browser = new Browser();
    const res = await signIn(browser, email);
    expect(res.status).toBe(302);
    expect(await sessionUser(browser)).not.toBeNull();
  });

  it("allows an exact email rule, and only that email", async () => {
    const email = unique("exact", "exact-rule.test");
    await access.add({ pattern: email, role: "user" }, ADMIN);
    await seedGoogle(email);
    const ok = new Browser();
    expect((await signIn(ok, email)).status).toBe(302);
    expect(await sessionUser(ok)).not.toBeNull();

    const neighbour = unique("other", "exact-rule.test");
    await seedGoogle(neighbour);
    const refused = new Browser();
    await expectPrivate(await loginCallback(refused, neighbour), refused);
  });

  it("refuses a returning user whose rule was removed, and their open session ends", async () => {
    const email = unique("leaver", "leaver.test");
    await access.add({ pattern: "keeper@leaver.test", role: "admin" }, ADMIN);
    await access.add({ pattern: email, role: "user" }, ADMIN);
    await seedGoogle(email);
    const browser = new Browser();
    await signIn(browser, email);
    expect((await browser.fetch("/accounts")).status).toBe(200);

    await access.remove(email, ADMIN);
    forgetAccessCache();
    // The open session no longer counts: the page sends the browser to sign in.
    const page = await browser.fetch("/accounts");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toMatch(/^\/login\?/);
    const again = new Browser();
    await expectPrivate(await loginCallback(again, email), again);
  });

  it("shows a stranger the private page, never whether their address is already connected", async () => {
    const email = unique("taken", "taken-domain.test");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES ('u_taken-owner', 'owner@taken-domain.test', 0)"),
      env.DB.prepare("INSERT INTO accounts (id, user_id, email, google_sub, created_at, updated_at) VALUES ('a_taken', 'u_taken-owner', ?, 'sub-taken-old', 0, 0)").bind(email),
    ]);
    // The same address under another Google identity: a reissued or recycled address.
    await seedGoogle(email);
    const browser = new Browser();
    await expectPrivate(await loginCallback(browser, email), browser);
  });

  it("ends sign-in and connect on a plain error page, never a 500, for an email that is not plain ASCII", async () => {
    const kelvin = `\u212Aaren-${crypto.randomUUID().slice(0, 8)}@fake.test`;
    await seedGoogle(kelvin);
    const signInRes = await loginCallback(new Browser(), kelvin);
    expect(signInRes.status).toBe(502);
    const signInPage = await signInRes.text();
    expect(signInPage).toContain("Sign-in failed");
    expect(signInPage).not.toContain("ASCII");

    const owner = uniqueEmail("kelvin-connector");
    await seedGoogle(owner);
    const browser = new Browser();
    await signIn(browser, owner);
    const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/accounts")).text())?.[1] ?? "";
    const start = await browser.fetch("/connections/connect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams([["csrf", csrf], ["service", "drive"]]).toString(),
    });
    expect(redirectsToGoogle(start)).toBe(true);
    const connectRes = await browser.fetch(await pickAtFake(start.headers.get("location") ?? "", kelvin));
    expect(connectRes.status).toBe(502);
    const connectPage = await connectRes.text();
    expect(connectPage).toContain("Google could not complete the sign-in. Start again.");
    expect(connectPage).not.toContain("ASCII");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email LIKE 'karen-%'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses the consent POST of a person removed elsewhere, even while this isolate still caches their role", async () => {
    const email = unique("consent", "consent-window.test");
    await access.add({ pattern: email, role: "user" }, ADMIN);
    await seedGoogle(email);
    const browser = new Browser();
    await signIn(browser, email);
    const clientId = await registerClient("Late Consent App");
    const { challenge } = await pkce();
    const page = await browser.fetch(authorizePath(clientId, challenge, crypto.randomUUID()));
    expect(page.status).toBe(200);
    const form = parseConsent(await page.text());
    // Removed by another isolate: this isolate's cache still says the person is allowed, so the session holds.
    await env.DB.prepare("DELETE FROM access_rules WHERE pattern = ?").bind(email).run();
    expect((await browser.fetch("/accounts")).status).toBe(200);
    const res = await browser.postForm("/authorize", [
      ["handle", form.handle],
      ["csrf", form.csrf],
      ["decision", "approve"],
      ...form.accounts.map((a): [string, string] => ["account", a.id]),
    ]);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(PRIVATE_MESSAGE);
    const approvals = await env.DB.prepare("SELECT COUNT(*) AS n FROM client_approvals WHERE client_id = ?").bind(clientId).first<{ n: number }>();
    expect(approvals?.n).toBe(0);
  });

  it("refuses a returning user whose own email lost its rule, even through another allowed email", async () => {
    await env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES ('u_gone-identity', 'gone@gone-identity.test', 0)").run();
    expect(await admitSignIn(env, { email: uniqueEmail("second"), userId: "u_gone-identity", existingUser: true })).toBe(false);
    expect(await admitSignIn(env, { email: uniqueEmail("second"), userId: "u_new", existingUser: false })).toBe(true);
  });
});

describe("the first sign-in on an empty list", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM access_rules"), env.DB.prepare("DELETE FROM access_audit")]);
    forgetAccessCache();
  });

  afterAll(async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO access_rules (pattern, role, note, created_by, created_at) VALUES ('@fake.test', 'user', NULL, 't', 0), ('@example.test', 'user', NULL, 't', 0)",
    ).run();
  });

  it("makes the first person to sign in the admin, then closes the list to everyone else", async () => {
    const first = unique("owner", "first-owner.test");
    const second = unique("late", "first-owner.test");
    await seedGoogle(first);
    await seedGoogle(second);
    const owner = new Browser();
    expect((await signIn(owner, first)).status).toBe(302);
    expect(await sessionUser(owner)).not.toBeNull();
    expect(await access.list()).toMatchObject([{ pattern: first, role: "admin", kind: "email" }]);
    const audit = await env.DB.prepare("SELECT via, action, pattern, role FROM access_audit").all();
    expect(audit.results).toEqual([{ via: "first-sign-in", action: "add", pattern: first, role: "admin" }]);

    const late = new Browser();
    await expectPrivate(await loginCallback(late, second), late);
  });

  it("bootstraps a returning user's own sign-in email, so signing in through another of their accounts makes them admin", async () => {
    await env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES ('u_s3', 'owner-s3@s3-primary.test', 0)").run();
    expect(await admitSignIn(env, { email: "side-s3@s3-secondary.test", userId: "u_s3", existingUser: true })).toBe(true);
    expect(await access.list()).toMatchObject([{ pattern: "owner-s3@s3-primary.test", role: "admin", createdBy: "u_s3" }]);
    // The same user signs in again either way; nobody else does.
    expect(await admitSignIn(env, { email: "owner-s3@s3-primary.test", userId: "u_s3", existingUser: true })).toBe(true);
    expect(await admitSignIn(env, { email: "side-s3@s3-secondary.test", userId: "u_new-s3", existingUser: false })).toBe(false);
  });

  it("never lets an address already in use bootstrap the list", async () => {
    expect(await admitSignIn(env, { email: "used@s3-taken.test", userId: "u_new-taken", existingUser: false, mayBootstrap: false })).toBe(false);
    expect(await access.list()).toEqual([]);
  });

  it("lets exactly one of two concurrent first sign-ins become admin", async () => {
    const a = unique("race-a", "race.test");
    const b = unique("race-b", "race.test");
    await seedGoogle(a);
    await seedGoogle(b);
    const [browserA, browserB] = [new Browser(), new Browser()];
    // Both reach Google's account picker before either callback runs, then both callbacks race.
    const [urlA, urlB] = await Promise.all([
      browserA.fetch("/login").then((r) => pickAtFake(r.headers.get("location") ?? "", a)),
      browserB.fetch("/login").then((r) => pickAtFake(r.headers.get("location") ?? "", b)),
    ]);
    const [resA, resB] = await Promise.all([browserA.fetch(urlA), browserB.fetch(urlB)]);
    const admitted = [resA, resB].filter((r) => redirectsToGoogle(r));
    const refused = [resA, resB].filter((r) => r.status === 403);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const rules = await access.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.role).toBe("admin");
    expect([a, b]).toContain(rules[0]?.pattern);
  });
});

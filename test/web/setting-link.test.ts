import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SERVICE_SCOPES } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { runExecute, type ExecuteReport } from "../../src/core/execute";
import { LINK_TTL_MS, linkKey } from "../../src/core/links";
import { RATE_WINDOW_MS } from "../../src/core/limits";
import type { CorePorts } from "../../src/core/ports";
import { SETTING_LINK_PATH, SETTING_LINK_RATE_LIMIT, mintSettingLink, type SettingLinkPort } from "../../src/core/setting-links";
import { settingsSetRefused } from "../../src/core/settings-capability";
import { isGwsError } from "../../src/errors";
import { workersPorts, workersSettingLinkPort } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { openUserSettings } from "../../src/store/user-settings";
import { ADS_ERRORS } from "../../src/web/pages/account-details";
import { SETTING_LINK_COPY } from "../../src/web/pages/setting-link";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, config, loginCallback } from "../auth/browser";
import worker from "../../src/index";
import { expectPlainLanguage } from "./plain-language";

/**
 * The one-time setting link end to end on the Workers runtime: an AI app gets a link (`settings.requestLink`, or with
 * the missing developer token error and the `settings.set` refusal), and the person sets the value on the link's page,
 * signed in. The value never passes through the AI app, and never appears in a response, an audit row or an execute.
 */

const settings = openUserSettings(env);
const ADS_SCOPES = [...SERVICE_SCOPES[config.GOOGLE_SCOPE_PRESET].ads];
/** The Workers ports plus the setting link page, as the MCP endpoint wires them. */
const remotePorts = (): CorePorts & { settingLinks: SettingLinkPort } => ({ ...workersPorts(env), settingLinks: workersSettingLinkPort(env) });

/** An obviously fake developer code, unique per test so a leak scan cannot match another test's rows. */
const fakeCode = () => `FAKE-link-code-${crypto.randomUUID().slice(0, 8)}`;

/** A user with one Google Ads account, its MCP client allowed on it, and a browser signed in as them. */
async function person(prefix: string) {
  const seeded = await seedUserWithAccount(env, { email: uniqueEmail(prefix), scopes: ADS_SCOPES, isDefault: true });
  const auth: AuthProps = { userId: seeded.userId, clientId: `c-link-${crypto.randomUUID().slice(0, 8)}` };
  await openStore(env).grants.add(auth.userId, auth.clientId, seeded.account.id);
  const browser = new Browser();
  const signed = await loginCallback(browser, seeded.account.email);
  if (signed.status !== 302) throw new Error(`sign-in failed: ${signed.status}`);
  return { auth, email: seeded.account.email, browser };
}

const run = (auth: AuthProps, code: string, opts: { ports?: CorePorts; now?: () => number } = {}): Promise<ExecuteReport> =>
  runExecute({ code, apply: false, auth, ports: opts.ports ?? remotePorts(), config, ...(opts.now ? { now: opts.now } : {}) });

/** `settings.requestLink` through an execute: the link's path (with its token) and the execute. */
async function requestLink(auth: AuthProps, key = "ads.developer_token") {
  const out = await run(auth, `async () => sdk.settings.requestLink({ key: ${JSON.stringify(key)} })`);
  if (!out.ok) throw new Error(`requestLink failed: ${JSON.stringify(out.error)}`);
  const link = out.result as { url: string; expiresAt: string };
  const url = new URL(link.url);
  return { out, link, path: `${url.pathname}${url.search}`, token: url.searchParams.get("t") ?? "" };
}

/** The hidden fields of the link page's form. */
function formOf(page: string): { csrf: string; t: string } {
  const csrf = /<form method="post" action="\/settings\/set"><input type="hidden" name="csrf" value="([^"]+)">/.exec(page)?.[1];
  const t = /<input type="hidden" name="t" value="([^"]+)">/.exec(page)?.[1];
  if (!csrf || !t) throw new Error("the page has no setting form");
  return { csrf, t };
}

function post(browser: Browser, fields: Record<string, string>, headers: Record<string, string> = { origin: BASE }): Promise<Response> {
  return browser.fetch(SETTING_LINK_PATH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * A browser on the real Worker entry with `wrap` applied to its env: the way to inject a store failure into one
 * request, in tests only.
 */
function browserWithEnv(cookies: Map<string, string>, wrap: (e: Env) => Env): Browser {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const b = new Browser((r) => worker.fetch(r as Request<unknown, IncomingRequestCfProperties>, wrap(env), ctx));
  for (const [k, v] of cookies) b.cookies.set(k, v);
  return b;
}

/** `target` with one method replaced; every other member still reaches the real binding. */
function overriding<T extends object>(target: T, name: string, replacement: unknown): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === name) return replacement;
      const v: unknown = Reflect.get(t, prop, t);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** `used_links` rows of the link with this token. */
async function usedRows(token: string): Promise<number> {
  const r = await env.DB.prepare("SELECT count(*) AS n FROM used_links WHERE token_hash = ?").bind(await linkKey("setting", token)).first<{ n: number }>();
  return r?.n ?? 0;
}

async function auditOf(userId: string): Promise<Array<Record<string, unknown>>> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE user_id = ? ORDER BY ts").bind(userId).all();
  return results;
}

function expectLinkHeaders(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  // The link's address goes to no other site; same-origin (not no-referrer) keeps the real Origin on the form's POST.
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
}

describe("settings.requestLink", () => {
  it("returns a one-time link to the setting page, ten minutes long, and audits that it was made (never the token)", async () => {
    const p = await person("link-mint");
    const before = Date.now();
    const { out, link, token } = await requestLink(p.auth);
    expect(Object.keys(link).sort()).toEqual(["expiresAt", "url"]);
    expect(link.url).toMatch(new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/settings/set\\?t=[A-Za-z0-9_-]{43}$`));
    const expires = Date.parse(link.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + LINK_TTL_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + LINK_TTL_MS);
    // Reading the link does not grant anything: nothing is set yet.
    expect(await settings.isSet(p.auth.userId, "ads.developer_token")).toBe(false);
    const rows = await auditOf(p.auth.userId);
    expect(rows.filter((r) => r.execute_id === out.executeId).map((r) => r.fn)).toEqual(
      expect.arrayContaining(["settings.requestLink", "settings.link.minted:ads.developer_token"]),
    );
    // Making a link changes nothing of the user's: audited like a read, also under apply.
    const minted = rows.find((r) => r.fn === "settings.link.minted:ads.developer_token");
    expect(minted).toMatchObject({ client_id: p.auth.clientId, effect: "read", applied: 0, status: "ok" });
    const applied = await runExecute({ code: 'async () => sdk.settings.requestLink({ key: "ads.login_customer_id" })', apply: true, auth: p.auth, ports: remotePorts(), config });
    const appliedRows = (await auditOf(p.auth.userId)).filter((r) => r.execute_id === applied.executeId && String(r.fn).startsWith("settings.link.minted"));
    expect(appliedRows).toEqual([expect.objectContaining({ effect: "read", applied: 0 })]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("refuses an unknown key", async () => {
    const p = await person("link-key");
    const out = await run(p.auth, 'async () => sdk.settings.requestLink({ key: "ads.something" })');
    expect(out.error?.code).toBe("GWS_INVALID_INPUT");
  });

  it("is limited per user: past the limit in one window it gives GWS_RATE_LIMITED", async () => {
    const p = await person("link-rate");
    const now = Date.now() - (Date.now() % RATE_WINDOW_MS) + 1000;
    const deps = { links: env.CACHE_KV, rate: openStore(env).rate, port: workersSettingLinkPort(env), baseUrl: BASE, auth: p.auth, executeId: "e-rate", now };
    for (let i = 0; i < SETTING_LINK_RATE_LIMIT - 1; i++) await mintSettingLink(deps, "ads.developer_token");
    // The last one the window allows, made by an execute; one more is refused.
    const last = await run(p.auth, 'async () => sdk.settings.requestLink({ key: "ads.login_customer_id" })', { now: () => now });
    expect(last.ok).toBe(true);
    const refused = await run(p.auth, 'async () => sdk.settings.requestLink({ key: "ads.developer_token" })', { now: () => now });
    expect(refused.error?.code).toBe("GWS_RATE_LIMITED");
    expect(refused.error?.details).toMatchObject({ scope: "setting-link", limit: SETTING_LINK_RATE_LIMIT });
    // The next window allows links again.
    const later = await mintSettingLink({ ...deps, now: now + RATE_WINDOW_MS }, "ads.developer_token").then(
      () => "ok",
      (e: unknown) => (isGwsError(e) ? e.code : "thrown"),
    );
    expect(later).toBe("ok");
  });
});

describe("the link page", () => {
  it("shows the signed-in person the form for exactly that setting, with no-store and a same-origin referrer policy, in plain words", async () => {
    const p = await person("link-page");
    const { path } = await requestLink(p.auth);
    const res = await p.browser.fetch(path);
    const page = await res.text();
    expect(res.status).toBe(200);
    expectLinkHeaders(res);
    expect(page).toContain('<meta name="referrer" content="same-origin">');
    expect(page).toContain("Set your Google Ads developer code");
    expect(page).toContain(`<span class="mono">${p.email}</span>`);
    expect(page).toContain('type="password" id="setting-value" name="value" value=""');
    expectPlainLanguage(page, { allow: [p.email] });
    // Viewing does not use the link up.
    expect((await p.browser.fetch(path)).status).toBe(200);
  });

  it("names the manager account ID for that key", async () => {
    const p = await person("link-page-mgr");
    const { path } = await requestLink(p.auth, "ads.login_customer_id");
    const page = await (await p.browser.fetch(path)).text();
    expect(page).toContain("Set your Google Ads manager account ID");
    expectPlainLanguage(page, { allow: [p.email] });
  });

  it("saves the value through the encrypted store, uses the link up, and audits the use; the value is in no response, audit row or execute", async () => {
    const p = await person("link-save");
    const { path, token } = await requestLink(p.auth);
    const page = await (await p.browser.fetch(path)).text();
    const code = fakeCode();
    const saved = await post(p.browser, { ...formOf(page), value: ` ${code} ` });
    const savedText = await saved.text();
    expect(saved.status).toBe(200);
    expectLinkHeaders(saved);
    expect(savedText).toContain(SETTING_LINK_COPY.saved("Google Ads developer code"));
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(code);
    const row = await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(p.auth.userId).first();
    expect(JSON.stringify(row)).not.toContain(code);

    // Used once: the same form again, or the link again, is refused.
    const replay = await post(p.browser, { ...formOf(page), value: fakeCode() });
    const replayText = await replay.text();
    expect([replay.status, replayText.includes(SETTING_LINK_COPY.invalid.replace(/'/g, "&#39;"))]).toEqual([400, true]);
    expect((await p.browser.fetch(path)).status).toBe(400);
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(code);

    const rows = await auditOf(p.auth.userId);
    expect(rows.map((r) => r.fn)).toEqual(expect.arrayContaining(["settings.link.minted:ads.developer_token", "settings.link.used:ads.developer_token"]));
    // The use is the person's own save on the web page, not the AI app's.
    const used = rows.filter((r) => r.fn === "settings.link.used:ads.developer_token");
    expect(used).toEqual([expect.objectContaining({ client_id: "web", effect: "write", applied: 1, status: "ok", execute_id: expect.stringMatching(/^web:/) })]);
    const audit = JSON.stringify(rows);
    for (const secret of [code, token]) expect(audit.includes(secret)).toBe(false);
    for (const body of [page, savedText, replayText]) expect(body.includes(code)).toBe(false);

    // The AI app learns only that it is set.
    const check = await run(p.auth, 'async () => sdk.settings.get({ key: "ads.developer_token" })');
    expect(check.result).toEqual({ key: "ads.developer_token", isSet: true });
    expect(JSON.stringify(check).includes(code)).toBe(false);
  });

  it("shows the form again for a refused value, never echoing it, and keeps the link", async () => {
    const p = await person("link-refused");
    const { path } = await requestLink(p.auth);
    const form = formOf(await (await p.browser.fetch(path)).text());
    const bad = `not a code ${crypto.randomUUID().slice(0, 8)}!`;
    const refused = await post(p.browser, { ...form, value: bad });
    const text = await refused.text();
    expect(refused.status).toBe(400);
    expectLinkHeaders(refused);
    expect(text).toContain(ADS_ERRORS.codeInvalid.replace(/'/g, "&#39;"));
    expect(text.includes(bad)).toBe(false);
    expect((await post(p.browser, { ...form, value: "" })).status).toBe(400);
    expect(await settings.isSet(p.auth.userId, "ads.developer_token")).toBe(false);
    expect((await post(p.browser, { ...form, value: fakeCode() })).status).toBe(200);
  });

  it("sends a signed-out browser to sign in and back to the link, unused", async () => {
    const p = await person("link-signin");
    const { path } = await requestLink(p.auth);
    const fresh = new Browser();
    const res = await fresh.fetch(path);
    expect(res.status).toBe(302);
    expectLinkHeaders(res);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
    const back = await loginCallback(fresh, p.email, path);
    expect([back.status, back.headers.get("location")]).toEqual([302, path]);
    const page = await fresh.fetch(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(p.email);
  });

  it("answers another signed-in person exactly as for a used or unknown link, and leaves the link unused", async () => {
    const owner = await person("link-owner");
    const other = await person("link-other");
    const { path } = await requestLink(owner.auth);
    const res = await other.browser.fetch(path);
    const text = await res.text();
    expect(res.status).toBe(400);
    expectLinkHeaders(res);
    expect(text.includes(owner.email)).toBe(false);
    // The same status and body as a link that is unknown, and as one that was used.
    const unknown = await other.browser.fetch(`${SETTING_LINK_PATH}?t=${"A".repeat(43)}`);
    expect([unknown.status, await unknown.text()]).toEqual([400, text]);
    const usedLink = await requestLink(other.auth);
    const usedForm = formOf(await (await other.browser.fetch(usedLink.path)).text());
    expect((await post(other.browser, { ...usedForm, value: fakeCode() })).status).toBe(200);
    const used = await other.browser.fetch(usedLink.path);
    expect([used.status, await used.text()]).toEqual([400, text]);
    // A POST by the other person, with their own session and CSRF token, gets the same answer.
    const ownerForm = formOf(await (await owner.browser.fetch(path)).text());
    const posted = await post(other.browser, { csrf: usedForm.csrf, t: ownerForm.t, value: fakeCode() });
    expect([posted.status, await posted.text()]).toEqual([400, text]);
    expect(await settings.isSet(owner.auth.userId, "ads.developer_token")).toBe(false);
    // The owner can still use it.
    expect((await post(owner.browser, { ...ownerForm, value: fakeCode() })).status).toBe(200);
  });

  it("saves once when the same form is posted twice at the same moment: one 200, one saved value, one used row", async () => {
    const p = await person("link-race");
    const { path, token } = await requestLink(p.auth);
    const form = formOf(await (await p.browser.fetch(path)).text());
    const values = [fakeCode(), fakeCode()];
    const responses = await Promise.all(values.map((value) => post(p.browser, { ...form, value })));
    const statuses = responses.map((r) => r.status).sort();
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(statuses).toEqual([200, 400]);
    const winner = values[responses.findIndex((r) => r.status === 200)];
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(winner);
    expect((await auditOf(p.auth.userId)).filter((r) => r.fn === "settings.link.used:ads.developer_token")).toHaveLength(1);
    expect(await usedRows(token)).toBe(1);
    for (const t of texts) for (const v of values) expect(t.includes(v)).toBe(false);
    for (const t of texts) expect(t.includes(token)).toBe(false);
  });

  it("never revives a link after a save and a clear: every save and clear moves the settings version", async () => {
    const p = await person("link-revive");
    const first = await requestLink(p.auth);
    const second = await requestLink(p.auth, "ads.login_customer_id");
    const firstForm = formOf(await (await p.browser.fetch(first.path)).text());
    const secondForm = formOf(await (await p.browser.fetch(second.path)).text());
    expect((await post(p.browser, { ...firstForm, value: fakeCode() })).status).toBe(200);
    expect((await p.browser.fetch(second.path)).status).toBe(409);
    // The AI app clears what was saved, so no value is saved again, as when both links were made.
    const cleared = await runExecute({ code: 'async () => sdk.settings.clear({ key: "ads.developer_token" })', apply: true, auth: p.auth, ports: remotePorts(), config });
    expect(cleared.result).toEqual({ applied: true, key: "ads.developer_token", cleared: true });
    expect(await settings.isSet(p.auth.userId, "ads.developer_token")).toBe(false);
    expect((await p.browser.fetch(second.path)).status).toBe(409);
    expect((await post(p.browser, { ...secondForm, value: "123-456-7890" })).status).toBe(409);
    expect(await settings.isSet(p.auth.userId, "ads.login_customer_id")).toBe(false);
    expect((await p.browser.fetch(first.path)).status).toBe(400);
  });

  it("leaves the link unused when the save fails, and saves on the next try", async () => {
    const p = await person("link-fail");
    const { path } = await requestLink(p.auth);
    const form = formOf(await (await p.browser.fetch(path)).text());
    // Every batch of this one request fails, as a database error would.
    const failing = browserWithEnv(p.browser.cookies, (e) => ({
      ...e,
      DB: overriding(e.DB, "batch", async () => {
        throw new Error("injected database failure");
      }),
    }));
    const failed = await post(failing, { ...form, value: fakeCode() });
    expect(failed.status).toBe(500);
    expect(await settings.isSet(p.auth.userId, "ads.developer_token")).toBe(false);
    expect((await auditOf(p.auth.userId)).filter((r) => String(r.fn).startsWith("settings.link.used"))).toEqual([]);
    expect(await usedRows(form.t)).toBe(0);
    expect((await p.browser.fetch(path)).status).toBe(200);
    const code = fakeCode();
    expect((await post(p.browser, { ...form, value: code })).status).toBe(200);
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(code);
  });

  it("reports a save that went through as saved, even when removing the link's record fails, and refuses the link after", async () => {
    const p = await person("link-kvfail");
    const { path } = await requestLink(p.auth);
    const form = formOf(await (await p.browser.fetch(path)).text());
    const failingDelete = browserWithEnv(p.browser.cookies, (e) => ({
      ...e,
      CACHE_KV: overriding(e.CACHE_KV, "delete", async (key: string) => {
        if (key.startsWith("req:setting:")) throw new Error("injected link store failure");
        return e.CACHE_KV.delete(key);
      }),
    }));
    const code = fakeCode();
    const saved = await post(failingDelete, { ...form, value: code });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain(SETTING_LINK_COPY.saved("Google Ads developer code"));
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(code);
    // The record is still in the link store, but the link is used: refused everywhere.
    expect((await p.browser.fetch(path)).status).toBe(400);
    expect((await post(p.browser, { ...form, value: fakeCode() })).status).toBe(400);
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(code);
  });

  it("refuses an expired link", async () => {
    const p = await person("link-expired");
    const deps = {
      links: env.CACHE_KV,
      rate: openStore(env).rate,
      port: workersSettingLinkPort(env),
      baseUrl: BASE,
      auth: p.auth,
      executeId: "e-expired",
      now: Date.now() - LINK_TTL_MS - 1000,
    };
    const { link } = await mintSettingLink(deps, "ads.developer_token");
    const url = new URL(link.url);
    const res = await p.browser.fetch(`${url.pathname}${url.search}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(SETTING_LINK_COPY.invalidTitle);
  });

  it("refuses a link whose setting changed after it was made", async () => {
    const p = await person("link-stale");
    const { path } = await requestLink(p.auth);
    const form = formOf(await (await p.browser.fetch(path)).text());
    const first = fakeCode();
    // Saved elsewhere (the account page, the CLI) after the link was made.
    await settings.set(p.auth.userId, "ads.developer_token", first);
    const view = await p.browser.fetch(path);
    expect([view.status, (await view.text()).includes(SETTING_LINK_COPY.staleTitle)]).toEqual([409, true]);
    expect((await post(p.browser, { ...form, value: fakeCode() })).status).toBe(409);
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(first);
  });

  it("checks the POST like every other form: an opaque Origin is refused too", async () => {
    const p = await person("link-guard");
    const { path } = await requestLink(p.auth);
    const form = formOf(await (await p.browser.fetch(path)).text());
    const value = fakeCode();
    const attempts: Array<[string, Record<string, string>, Record<string, string>, Browser]> = [
      ["another site's Origin", form, { origin: "https://evil.example" }, p.browser],
      ["an opaque Origin", form, { origin: "null" }, p.browser],
      ["an opaque Origin, even with same-origin fetch metadata", form, { origin: "null", "sec-fetch-site": "same-origin" }, p.browser],
      ["no Origin", form, {}, p.browser],
      ["a wrong CSRF token", { ...form, csrf: "x".repeat(43) }, { origin: BASE }, p.browser],
    ];
    for (const [label, fields, headers, browser] of attempts) {
      const res = await post(browser, { ...fields, value }, headers);
      expect([label, res.status]).toEqual([label, 403]);
    }
    expect((await post(new Browser(), { ...form, value }, { origin: BASE })).status).toBe(401);
    expect(await settings.isSet(p.auth.userId, "ads.developer_token")).toBe(false);
    // What a browser sends from the page itself: this site's Origin.
    const ok = await post(p.browser, { ...form, value }, { origin: BASE, "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(await settings.get(p.auth.userId, "ads.developer_token")).toBe(value);
  });
});

describe("errors that offer the link", () => {
  it("the missing developer token error carries a link that sets it, and the Ads call then works", async () => {
    const p = await person("link-missing");
    const ads = "async () => sdk.googleads.customers.listAccessibleCustomers({})";
    const missing = await run(p.auth, ads);
    expect(missing.error?.code).toBe("GWS_ADS_DEVELOPER_TOKEN_MISSING");
    expect(missing.error?.message).toContain("details.setLink");
    const setLink = missing.error?.details?.setLink as { url: string; expiresAt: string };
    expect(missing.error?.details).toEqual({ setting: "ads.developer_token", setLink: { url: expect.stringContaining(`${BASE}/settings/set?t=`), expiresAt: expect.any(String) } });
    const url = new URL(setLink.url);
    const code = fakeCode();
    const form = formOf(await (await p.browser.fetch(`${url.pathname}${url.search}`)).text());
    expect((await post(p.browser, { ...form, value: code })).status).toBe(200);
    const after = await run(p.auth, ads);
    expect(after.ok).toBe(true);
    expect(JSON.stringify(after).includes(code)).toBe(false);
  });

  it("the settings.set refusal carries a link for a known key, still refuses before anything else, and never echoes the value", async () => {
    const p = await person("link-set");
    const offered = `FAKE-offered-${crypto.randomUUID().slice(0, 8)}`;
    const out = await run(
      p.auth,
      `async () => {
        const seen = [];
        for (const input of [{ key: "ads.developer_token", value: ${JSON.stringify(offered)} }, { key: "ads.developer_token", value: 1 }, { key: "nope", value: ${JSON.stringify(offered)} }, ${JSON.stringify(offered)}]) {
          try { await sdk.settings.set(input); } catch (e) { seen.push({ code: e.code, message: e.message, details: e.details }); }
        }
        return seen;
      }`,
    );
    expect(out.ok).toBe(true);
    const seen = out.result as Array<{ code: string; message: string; details: Record<string, unknown> }>;
    const plain = settingsSetRefused();
    // A known key: the refusal plus one link (the same link both times: one per key and execute).
    expect(seen[0]?.code).toBe("GWS_INVALID_INPUT");
    expect(seen[0]?.message).toContain("details.setLink");
    expect(seen[0]?.details).toEqual({ reason: "set_outside_ai_app", setLink: { url: expect.stringContaining(`${BASE}/settings/set?t=`), expiresAt: expect.any(String) } });
    expect(seen[1]?.details).toEqual(seen[0]?.details);
    // No known key (or no object at all): the plain refusal, no link.
    expect(seen[2]).toEqual({ code: "GWS_INVALID_INPUT", message: `GWS_INVALID_INPUT: ${plain.message}`, details: plain.details });
    expect(seen[3]).toEqual(seen[2]);
    expect(out.plan).toEqual([]);
    expect(JSON.stringify(out).includes(offered)).toBe(false);
    const rows = await auditOf(p.auth.userId);
    expect(rows.filter((r) => r.execute_id === out.executeId && String(r.fn).startsWith("settings.link.minted")).length).toBe(1);
    expect(JSON.stringify(rows).includes(offered)).toBe(false);
    expect(await settings.isSet(p.auth.userId, "ads.developer_token")).toBe(false);
  });

  it("carry no link where the runtime has no setting page", async () => {
    const p = await person("link-none");
    const ports = workersPorts(env);
    const missing = await run(p.auth, "async () => sdk.googleads.customers.listAccessibleCustomers({})", { ports });
    expect(missing.error?.details).toEqual({ setting: "ads.developer_token" });
    const refused = await run(p.auth, 'async () => sdk.settings.set({ key: "ads.developer_token", value: "x" })', { ports });
    expect(refused.error?.details).toEqual({ reason: "set_outside_ai_app" });
    const link = await run(p.auth, 'async () => sdk.settings.requestLink({ key: "ads.developer_token" })', { ports });
    expect(link.error?.code).toBe("GWS_UNSUPPORTED_RUNTIME");
    expect(link.error?.message).toContain("gws-mcp settings set ads.developer_token");
  });
});

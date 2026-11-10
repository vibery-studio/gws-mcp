import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SERVICE_SCOPES } from "../../src/config";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";
import { BASE, Browser, approveClient, config, grantRows, loginCallback, mcpToolsList } from "../auth/browser";

/**
 * Percent-encoded paths and ids reach the same handlers as their plain form, behind the same session, Origin
 * and CSRF checks, and still only for the signed-in user's own accounts and AI apps. An encoded id that
 * decodes to something else (a dot segment, a slash, a control character, a space) is not an id of theirs.
 */

const store = openStore(env);
const preset = config.GOOGLE_SCOPE_PRESET;
const SCOPES = [...SERVICE_SCOPES[preset].gmail, ...SERVICE_SCOPES[preset].drive];

function post(browser: Browser, path: string, fields: Array<[string, string]>, origin: string | null = BASE): Promise<Response> {
  return browser.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Every character as %XX, letters included. */
const encodeAll = (s: string) => [...new TextEncoder().encode(s)].map((b) => `%${b.toString(16).padStart(2, "0").toUpperCase()}`).join("");

/** A signed-in user with two connected accounts (a default one and a second) and one AI app allowed the first. */
async function signedIn(prefix: string) {
  const first = await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-a`), scopes: SCOPES, isDefault: true });
  const second = (await seedUserWithAccount(env, { email: uniqueEmail(`${prefix}-b`), scopes: SCOPES, userId: first.userId })).account;
  const browser = new Browser();
  expect((await loginCallback(browser, first.account.email)).status).toBe(302);
  const app = await approveClient(browser, `Encoded ${prefix}`, (form) => form.accounts.filter((a) => a.id === first.account.id).map((a) => a.id));
  const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await (await browser.fetch("/accounts")).text())?.[1] ?? "";
  return { userId: first.userId, browser, csrf, app, first: first.account, second };
}

/** Everything these actions could change for `userId`. */
async function snapshot(userId: string) {
  const accounts = await store.accounts.listForUser(userId);
  const { results: grants } = await env.DB.prepare("SELECT client_id, account_id FROM client_grants WHERE user_id = ? ORDER BY client_id, account_id").bind(userId).all();
  return { accounts, grants };
}

describe("percent-encoded paths on the AI app access form", () => {
  it("keeps the session, Origin and CSRF checks on every encoding of the path, and saves only with them", async () => {
    const s = await signedIn("enc-access");
    const appId = s.app.clientId;
    const variants = [`/%61pps/${appId}/access`, `/apps/${appId}/%61ccess`, `/apps/${encodeAll(appId)}/access`, `/%61%70%70%73/${encodeAll(appId)}/%61ccess`];
    let allowed = [s.first.id];
    for (const path of variants) {
      const before = await snapshot(s.userId);
      const wanted = allowed.length === 1 ? [s.first.id, s.second.id] : [s.first.id];
      const fields: Array<[string, string]> = [["shown", allowed.join(" ")], ...wanted.map((a): [string, string] => ["account", a])];
      for (const [label, res] of [
        ["no session", await post(new Browser(), path, [["csrf", s.csrf], ...fields])],
        ["no CSRF token", await post(s.browser, path, fields)],
        ["a wrong CSRF token", await post(s.browser, path, [["csrf", "x".repeat(43)], ...fields])],
        ["another site's Origin", await post(s.browser, path, [["csrf", s.csrf], ...fields], "https://evil.example")],
        ["no Origin", await post(s.browser, path, [["csrf", s.csrf], ...fields], null)],
      ] as const) {
        expect([path, label, res.status]).toEqual([path, label, label === "no session" ? 401 : 403]);
      }
      expect(await snapshot(s.userId)).toEqual(before);

      const ok = await post(s.browser, path, [["csrf", s.csrf], ...fields]);
      expect([path, ok.status, ok.headers.get("location")]).toEqual([path, 303, `/apps/${encodeURIComponent(appId)}`]);
      expect(await grantRows(s.userId, appId)).toEqual([...wanted].sort());
      allowed = wanted;
    }
  });

  it("answers 404 for ids that decode to a dot segment, a slash, a control character or a space, or to another user's app, changing nothing", async () => {
    const mine = await signedIn("enc-ids-mine");
    const theirs = await signedIn("enc-ids-theirs");
    const before = { mine: await snapshot(mine.userId), theirs: await snapshot(theirs.userId) };
    const fields: Array<[string, string]> = [["csrf", mine.csrf], ["shown", mine.first.id], ["account", mine.first.id], ["account", mine.second.id]];
    const id = mine.app.clientId;
    for (const encoded of ["%2e%2e", "..%2fapps", `${id}%00`, `${id}%20`, `%20${id}`, `${id}%2f`, encodeAll(theirs.app.clientId)]) {
      const res = await post(mine.browser, `/apps/${encoded}/access`, fields);
      expect([encoded, res.status]).toEqual([encoded, 404]);
      await res.body?.cancel();
    }
    expect({ mine: await snapshot(mine.userId), theirs: await snapshot(theirs.userId) }).toEqual(before);
  });
});

describe("percent-encoded paths on the account and page routes", () => {
  it("saves an account name through an encoded path only to the user's own account, by its stored id", async () => {
    const mine = await signedIn("enc-name-mine");
    const theirs = await signedIn("enc-name-theirs");
    const own = await post(mine.browser, `/%61ccounts/${encodeAll(mine.second.id)}/name`, [["csrf", mine.csrf], ["alias", "encoded"]]);
    expect([own.status, own.headers.get("location")]).toEqual([303, `/accounts/${encodeURIComponent(mine.second.id)}`]);
    expect((await store.accounts.get(mine.userId, mine.second.id))?.alias).toBe("encoded");

    const before = await snapshot(theirs.userId);
    for (const path of [`/accounts/${encodeAll(theirs.second.id)}/name`, `/%61ccounts/${theirs.second.id}/%6eame`]) {
      const res = await post(mine.browser, path, [["csrf", mine.csrf], ["alias", "taken"]]);
      expect([path, res.status]).toEqual([path, 404]);
      await res.body?.cancel();
    }
    const unguarded = await post(mine.browser, `/%61ccounts/${encodeAll(mine.second.id)}/name`, [["alias", "unguarded"]]);
    expect(unguarded.status).toBe(403);
    expect(await snapshot(theirs.userId)).toEqual(before);
    expect((await store.accounts.get(mine.userId, mine.second.id))?.alias).toBe("encoded");
  });

  it("gates encoded page paths by sign-in and serves them only for the user's own ids", async () => {
    const mine = await signedIn("enc-get-mine");
    const theirs = await signedIn("enc-get-theirs");
    const own = [`/%61ccounts/${encodeAll(mine.first.id)}`, `/%61pps/${encodeAll(mine.app.clientId)}`, `/apps/${encodeAll(mine.app.clientId)}/%72emove`];
    for (const path of own) {
      const out = await new Browser().fetch(path);
      expect([path, out.status, out.headers.get("location")?.startsWith("/login?next=")]).toEqual([path, 302, true]);
      const res = await mine.browser.fetch(path);
      expect([path, res.status]).toEqual([path, 200]);
      await res.body?.cancel();
    }
    for (const path of [`/%61ccounts/${encodeAll(theirs.first.id)}`, `/%61pps/${encodeAll(theirs.app.clientId)}`]) {
      const res = await mine.browser.fetch(path);
      const page = await res.text();
      expect([path, res.status]).toEqual([path, 404]);
      expect(page).not.toContain(theirs.first.email);
    }
  });

  it("keeps the older AI app actions' checks and their 403 for another user's app on encoded paths", async () => {
    const mine = await signedIn("enc-old-mine");
    const theirs = await signedIn("enc-old-theirs");
    const path = "/%63onnections/client-revoke";
    const noCsrf = await post(mine.browser, path, [["client", mine.app.clientId]]);
    expect(noCsrf.status).toBe(403);
    const foreign = await post(mine.browser, path, [["csrf", mine.csrf], ["client", theirs.app.clientId]]);
    expect(foreign.status).toBe(403);
    expect(await mcpToolsList(theirs.app.accessToken)).toBe(200);
    expect(await mcpToolsList(mine.app.accessToken)).toBe(200);
    const own = await post(mine.browser, path, [["csrf", mine.csrf], ["client", mine.app.clientId]]);
    expect([own.status, own.headers.get("location")]).toEqual([303, "/apps"]);
    expect(await mcpToolsList(mine.app.accessToken)).toBe(401);
  });
});

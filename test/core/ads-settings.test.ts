import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { runExecute, type ExecuteReport } from "../../src/core/execute";
import type { CorePorts, SandboxRequest } from "../../src/core/ports";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { openUserSettings } from "../../src/store/user-settings";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";
import { REDACTED } from "../../src/core/redact";
import { settingsSetRefused } from "../../src/core/settings-capability";

/**
 * The Google Ads settings end to end on the Workers runtime: real D1 settings, the real sandbox and the fake Google.
 * The developer token and login customer id go out only as headers on Google Ads requests. The developer token never
 * reaches the sandbox, a result, a log, an error, a plan step or an audit row. The login customer id is an account
 * number, not a credential: gws-mcp never puts it anywhere itself, but Google's own Ads data may hold it, unredacted.
 */

const config = loadConfig(env);
const G = "https://www.googleapis.com/auth/";
const ADWORDS = `${G}adwords`;
const DRIVE_FILE = `${G}drive.file`;
const settings = openUserSettings(env);

/** Obviously fake values, unique per test so a leak scan cannot match another test's rows. */
function fakeValues() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return {
    token: `FAKE-dev-token-${crypto.randomUUID().slice(0, 8)}`,
    login: `55${String(n % 100_000_000).padStart(8, "0")}`,
  };
}

interface Sent {
  host: string;
  path: string;
  developerToken: string | null;
  loginCustomerId: string | null;
}

/** A user with one account (Ads and Drive) granted to the test client, optionally with saved Ads settings. */
async function adsUser(values?: { token?: string; login?: string }) {
  const seeded = await seedUserWithAccount(env, { email: uniqueEmail("ads-settings"), scopes: [ADWORDS, DRIVE_FILE], isDefault: true });
  const auth: AuthProps = { userId: seeded.userId, clientId: `c-ads-${crypto.randomUUID().slice(0, 8)}` };
  await openStore(env).grants.add(auth.userId, auth.clientId, seeded.account.id);
  if (values?.token !== undefined) await settings.set(auth.userId, "ads.developer_token", values.token);
  if (values?.login !== undefined) await settings.set(auth.userId, "ads.login_customer_id", values.login);
  return { auth, email: seeded.account.email };
}

/**
 * The Workers ports, observed: every API request's Ads headers, every token refresh, and everything that crosses into
 * the sandbox (the code, the prelude and each value an SDK call hands back). `answer` replaces the fake's reply.
 */
function observedPorts(answer?: (url: URL) => Response | undefined) {
  const base = workersPorts(env);
  const sent: Sent[] = [];
  const crossed: string[] = [];
  let refreshes = 0;
  const ports: CorePorts = {
    ...base,
    tokens: {
      getAccessToken: (account) => {
        refreshes++;
        return base.tokens.getAccessToken(account);
      },
      invalidate: base.tokens.invalidate,
    },
    http: {
      upstream: base.http.upstream,
      send: async (url, init) => {
        const u = new URL(url);
        const h = new Headers(init?.headers);
        sent.push({ host: u.hostname, path: u.pathname, developerToken: h.get("developer-token"), loginCustomerId: h.get("login-customer-id") });
        return answer?.(u) ?? base.http.send(url, init);
      },
    },
    sandbox: {
      normalize: base.sandbox.normalize,
      run: (req: SandboxRequest) => {
        crossed.push(req.code, req.prelude);
        return base.sandbox.run({
          ...req,
          call: async (name, input) => {
            const out = await req.call(name, input);
            crossed.push(JSON.stringify(out));
            return out;
          },
        });
      },
    },
  };
  return { ports, sent, crossed, refreshes: () => refreshes };
}

async function auditOf(executeId: string): Promise<string> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE execute_id = ? ORDER BY ts").bind(executeId).all();
  return JSON.stringify(results);
}

function expectAbsent(where: string, text: string, values: readonly string[]): void {
  for (const v of values) expect(text.includes(v), `${where} holds a setting value`).toBe(false);
}

const run = (o: { code: string; auth: AuthProps; ports: CorePorts; apply?: boolean }): Promise<ExecuteReport> =>
  runExecute({ code: o.code, apply: o.apply ?? false, auth: o.auth, ports: o.ports, config });

describe("Google Ads headers", () => {
  it("are sent, read host-side from the user's settings, only on requests to the Google Ads host", async () => {
    const v = fakeValues();
    const u = await adsUser(v);
    const o = observedPorts();
    const out = await run({
      code: "async () => { await sdk.googleads.customers.listAccessibleCustomers({}); await sdk.drive.files.list({}); return 'done'; }",
      auth: u.auth,
      ports: o.ports,
    });
    expect(out).toMatchObject({ ok: true, result: "done" });
    const ads = o.sent.filter((s) => s.host === "googleads.googleapis.com");
    const others = o.sent.filter((s) => s.host !== "googleads.googleapis.com");
    expect(ads).toEqual([{ host: "googleads.googleapis.com", path: "/v23/customers:listAccessibleCustomers", developerToken: v.token, loginCustomerId: v.login }]);
    expect(others.length).toBeGreaterThan(0);
    for (const s of others) expect([s.path, s.developerToken, s.loginCustomerId]).toEqual([s.path, null, null]);
    // The fake Ads API received them: it records whether a token came and which login customer id.
    const calls = Object.entries((await fake.state(u.email)).resources)
      .filter(([k]) => k.startsWith(`ads:call:${u.email}:`))
      .map(([, c]) => c as { developerToken: boolean; loginCustomerId: string | null });
    expect(calls.map((c) => [c.developerToken, c.loginCustomerId])).toEqual([[true, v.login]]);
  });

  it("leave out login-customer-id when none is saved", async () => {
    const v = fakeValues();
    const u = await adsUser({ token: v.token });
    const o = observedPorts();
    expect(await run({ code: "async () => { await sdk.googleads.customers.listAccessibleCustomers({}); }", auth: u.auth, ports: o.ports })).toMatchObject({ ok: true });
    expect(o.sent.filter((s) => s.host === "googleads.googleapis.com").map((s) => [s.developerToken, s.loginCustomerId])).toEqual([[v.token, null]]);
  });

  it("without a saved developer token, refuse the Ads call with GWS_ADS_DEVELOPER_TOKEN_MISSING before any Google request", async () => {
    const u = await adsUser({ login: fakeValues().login });
    const o = observedPorts();
    const out = await run({ code: "async () => sdk.googleads.customers.listAccessibleCustomers({})", auth: u.auth, ports: o.ports });
    expect(out.error?.code).toBe("GWS_ADS_DEVELOPER_TOKEN_MISSING");
    expect(out.error?.message).toContain("Google accounts → the account → Google Ads");
    expect(out.error?.message).toContain("gws-mcp settings set ads.developer_token");
    expect(out.calls).toEqual([expect.objectContaining({ fn: "googleads.customers.listAccessibleCustomers", status: "error", code: "GWS_ADS_DEVELOPER_TOKEN_MISSING" })]);
    // No API request and no token refresh: nothing reached Google.
    expect(o.sent).toEqual([]);
    expect(o.refreshes()).toBe(0);
    expect(await auditOf(out.executeId)).toContain('"code":"GWS_ADS_DEVELOPER_TOKEN_MISSING"');
  });

  it("with a saved value that no longer decrypts, refuse the Ads call with a structured error naming that setting, before any Google request", async () => {
    for (const key of ["ads.developer_token", "ads.login_customer_id"] as const) {
      const v = fakeValues();
      const u = await adsUser(v);
      await env.DB.prepare("UPDATE user_settings SET value_ct = ? WHERE user_id = ? AND key = ?").bind("A".repeat(40), u.auth.userId, key).run();
      const o = observedPorts();
      const out = await run({ code: "async () => sdk.googleads.customers.listAccessibleCustomers({})", auth: u.auth, ports: o.ports });
      expect([key, out.error?.code, out.error?.details]).toEqual([key, "GWS_SETTING_UNREADABLE", { setting: key }]);
      expect(out.error?.message).toContain(`Save it again in gws-mcp under Google accounts → the account → Google Ads`);
      expect(out.error?.message).toContain(`gws-mcp settings set ${key}`);
      expect([o.sent, o.refreshes()]).toEqual([[], 0]);
      expect(await auditOf(out.executeId)).toContain('"code":"GWS_SETTING_UNREADABLE"');
      // Saving the value again fixes it.
      await settings.set(u.auth.userId, key, key === "ads.developer_token" ? v.token : v.login);
      expect((await run({ code: "async () => sdk.googleads.customers.listAccessibleCustomers({})", auth: u.auth, ports: o.ports })).ok).toBe(true);
    }
  });

  it("are not needed to plan an Ads write in dry-run, and the plan never holds them", async () => {
    const v = fakeValues();
    const u = await adsUser(v);
    const o = observedPorts();
    const out = await run({
      code: "async () => sdk.googleads.customers.campaigns.mutate({ customerId: '9876543210', requestBody: { operations: [{ remove: 'customers/9876543210/campaigns/1' }] } })",
      auth: u.auth,
      ports: o.ports,
    });
    expect(out.ok).toBe(true);
    expect(out.plan).toHaveLength(1);
    expect(out.plan[0]).toMatchObject({ fn: "googleads.customers.campaigns.mutate", effect: "write", destructive: true });
    expect(o.sent).toEqual([]);
    expectAbsent("the plan", JSON.stringify(out.plan), [v.token, v.login]);
  });
});

describe("the Ads setting values", () => {
  it("the developer token never crosses into the sandbox, nor reaches the result, logs, error, plan or audit", async () => {
    const v = fakeValues();
    const u = await adsUser(v);
    const o = observedPorts();
    const code = `async () => {
      const seen = [];
      seen.push(await sdk.settings.get({ key: "ads.developer_token" }), await sdk.settings.get({ key: "ads.login_customer_id" }));
      seen.push(await sdk.googleads.customers.listAccessibleCustomers({}));
      seen.push(await sdk.googleads.customers.campaigns.mutate({ customerId: "9876543210", requestBody: { operations: [{ remove: "customers/9876543210/campaigns/1" }] } }));
      seen.push(await sdk.settings.clear({ key: "ads.developer_token" }));
      try { await sdk.googleads.customers.googleAds.search({ customerId: "1112223334", requestBody: { query: "SELECT campaign.id FROM campaign" } }); }
      catch (e) { seen.push({ code: e.code, message: e.message, details: e.details }); }
      console.log(JSON.stringify(seen));
      throw new Error(JSON.stringify(seen));
    }`;
    const out = await run({ code, auth: u.auth, ports: o.ports });
    expect(out.ok).toBe(false);
    // The snippet saw only whether each key is set.
    expect(out.error?.message).toContain('{"key":"ads.developer_token","isSet":true}');
    expect(out.error?.message).toContain('{"key":"ads.login_customer_id","isSet":true}');
    // The Ads API was called with the values as headers, so they were in use.
    expect(o.sent.filter((s) => s.host === "googleads.googleapis.com").map((s) => s.developerToken)).toEqual([v.token, v.token]);
    expectAbsent("the sandbox traffic", o.crossed.join("\n"), [v.token]);
    expectAbsent("the execute output", JSON.stringify(out), [v.token]);
    expectAbsent("the audit rows", await auditOf(out.executeId), [v.token]);
    // gws-mcp's own records never hold the login customer id either (this account's Ads data holds none of it).
    expectAbsent("the plan", JSON.stringify(out.plan), [v.login]);
    expectAbsent("the audit rows", await auditOf(out.executeId), [v.login]);
    expectAbsent("the sandbox traffic", o.crossed.join("\n"), [v.login]);
    // The dry-run clear changed nothing.
    expect(await settings.get(u.auth.userId, "ads.developer_token")).toBe(v.token);
  });

  it("redact the developer token from the output even when Google's answer echoes it, but not the login customer id", async () => {
    const v = fakeValues();
    const u = await adsUser(v);
    const o = observedPorts((url) =>
      url.hostname === "googleads.googleapis.com" ? Response.json({ resourceNames: [`customers/${v.login}`, `echo ${v.token}`] }) : undefined,
    );
    const out = await run({
      code: "async () => { const r = await sdk.googleads.customers.listAccessibleCustomers({}); console.log(r.resourceNames.join(' ')); return r; }",
      auth: u.auth,
      ports: o.ports,
    });
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ resourceNames: [`customers/${v.login}`, `echo ${REDACTED}`] });
    expect(out.logs).toEqual([`customers/${v.login} echo ${REDACTED}`]);
    expectAbsent("the execute output", JSON.stringify(out), [v.token]);
  });

  it("leave Google's own Ads data intact: listAccessibleCustomers through the fake returns the manager id unredacted", async () => {
    const v = fakeValues();
    const u = await adsUser(v);
    // The saved login customer id is the account's manager, so Google lists it.
    await fake.seed({
      resources: [
        { key: `ads:customer:${u.email}:${v.login}`, value: { id: v.login, descriptiveName: "Example Agency", currencyCode: "USD", timeZone: "Asia/Saigon", manager: true } },
      ],
    });
    const o = observedPorts();
    const out = await run({ code: "async () => sdk.googleads.customers.listAccessibleCustomers({})", auth: u.auth, ports: o.ports });
    expect(out).toMatchObject({ ok: true, result: { resourceNames: [`customers/${v.login}`] } });
    expect(o.sent.filter((s) => s.host === "googleads.googleapis.com").map((s) => [s.developerToken, s.loginCustomerId])).toEqual([[v.token, v.login]]);
    expectAbsent("the execute output", JSON.stringify(out), [v.token]);
    expectAbsent("the audit rows", await auditOf(out.executeId), [v.token, v.login]);
  });
});

describe("sdk.settings", () => {
  it("get answers { key, isSet } only, and refuses an unknown key", async () => {
    const v = fakeValues();
    const u = await adsUser({ token: v.token });
    const o = observedPorts();
    const out = await run({
      code: `async () => [await sdk.settings.get({ key: "ads.developer_token" }), await sdk.settings.get({ key: "ads.login_customer_id" })]`,
      auth: u.auth,
      ports: o.ports,
    });
    expect(out.result).toEqual([
      { key: "ads.developer_token", isSet: true },
      { key: "ads.login_customer_id", isSet: false },
    ]);
    const bad = await run({ code: `async () => sdk.settings.get({ key: "ads.other" })`, auth: u.auth, ports: o.ports });
    expect(bad.error?.code).toBe("GWS_INVALID_INPUT");
  });

  it("clear is planned in dry-run (no value in the step) and runs only under apply", async () => {
    const v = fakeValues();
    const u = await adsUser(v);
    const o = observedPorts();
    const dry = await run({ code: `async () => sdk.settings.clear({ key: "ads.developer_token" })`, auth: u.auth, ports: o.ports });
    expect(dry.result).toEqual({ applied: false, step: "s1" });
    expect(dry.plan).toEqual([
      {
        step: "s1",
        fn: "settings.clear",
        effect: "write",
        destructive: false,
        note: "clear your saved Google Ads developer token; Google Ads calls stop working until it is set again",
      },
    ]);
    expect(await settings.isSet(u.auth.userId, "ads.developer_token")).toBe(true);

    const applied = await run({ code: `async () => sdk.settings.clear({ key: "ads.developer_token" })`, auth: u.auth, ports: o.ports, apply: true });
    expect(applied.result).toEqual({ applied: true, key: "ads.developer_token", cleared: true });
    expect(await settings.isSet(u.auth.userId, "ads.developer_token")).toBe(false);
    expect(await settings.get(u.auth.userId, "ads.login_customer_id")).toBe(v.login);
    expect(await auditOf(applied.executeId)).toContain('"fn":"settings.clear","effect":"write","applied":1,"status":"ok"');
    const again = await run({ code: `async () => sdk.settings.clear({ key: "ads.developer_token" })`, auth: u.auth, ports: o.ports, apply: true });
    expect(again.result).toEqual({ applied: true, key: "ads.developer_token", cleared: false });
  });

  it("set is refused from a snippet, whatever the input, and never echoes it", async () => {
    const v = fakeValues();
    const u = await adsUser({ token: v.token });
    const offered = `FAKE-offered-${crypto.randomUUID().slice(0, 8)}`;
    const o = observedPorts();
    for (const apply of [false, true]) {
      const out = await run({
        code: `async () => {
          const input = { key: "ads.developer_token", value: ${JSON.stringify(offered)} };
          let caught;
          try { await sdk.settings.set(input); } catch (e) { caught = { code: e.code, message: e.message, details: e.details }; }
          console.log("offered " + input.value);
          return { caught, input };
        }`,
        auth: u.auth,
        ports: o.ports,
        apply,
      });
      expect(out.ok).toBe(true);
      // Exactly the constant refusal: a message that echoed the value would differ here, redacted or not.
      const caught = (out.result as { caught: { code: string; message: string; details: unknown } }).caught;
      const refusal = settingsSetRefused();
      expect(caught).toEqual({ code: "GWS_INVALID_INPUT", message: `GWS_INVALID_INPUT: ${refusal.message}`, details: refusal.details });
      expect(out.plan).toEqual([]);
      expect(out.calls).toEqual([expect.objectContaining({ fn: "settings.set", status: "error", code: "GWS_INVALID_INPUT" })]);
      expectAbsent("the execute output", JSON.stringify(out), [offered]);
      expectAbsent("the audit rows", await auditOf(out.executeId), [offered]);
    }
    // A value that waits on an unexecuted write is refused too, never planned.
    const pending = await run({
      code: `async () => { const f = await sdk.drive.files.create({ requestBody: { name: "x" } }); await sdk.settings.set({ key: "ads.developer_token", value: f.id }); }`,
      auth: u.auth,
      ports: o.ports,
    });
    expect(pending.error?.code).toBe("GWS_INVALID_INPUT");
    expect(pending.plan.map((s) => s.fn)).toEqual(["drive.files.create"]);
    expect(await settings.get(u.auth.userId, "ads.developer_token")).toBe(v.token);
  });
});

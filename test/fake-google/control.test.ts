import { describe, expect, it } from "vitest";
import { createFakeGoogle } from "../../fake-google/src/app";
import { loadSeedFixture, parseFixture } from "../../fake-google/src/fixtures";
import type { FakeRoute } from "../../fake-google/src/routes/index";
import { MemoryStore } from "../../fake-google/src/store";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "../../src/config";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const USERINFO = "/openidconnect.googleapis.com/v1/userinfo";
const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const SIGNING_KEY = "control-test-signing-key";

function form(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Handler = (req: Request) => Promise<Response>;

/** Runs the authorize/approve/token dance against `call` and returns the token response. */
async function login(
  call: Handler,
  email: string,
  scopes: string[],
): Promise<{ access_token: string; refresh_token: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const redirect = "http://localhost/google/callback";
  const approve = await call(
    new Request(
      "http://fake/accounts.google.com/o/oauth2/v2/auth/approve",
      form({
        client_id: FAKE_CLIENT_ID,
        redirect_uri: redirect,
        response_type: "code",
        scope: scopes.join(" "),
        state: "s1",
        code_challenge: challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        email,
        decision: "allow",
      }),
    ),
  );
  expect(approve.status).toBe(302);
  const code = new URL(approve.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const tok = await call(
    new Request(
      "http://fake/oauth2.googleapis.com/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      }),
    ),
  );
  expect(tok.status).toBe(200);
  return (await tok.json()) as { access_token: string; refresh_token: string };
}

/** The service-binding fake as a plain handler, so the same login helper works for both. */
const viaBinding: Handler = async (req) => {
  const url = new URL(req.url);
  return fakeFetch(`${url.pathname}${url.search}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" ? undefined : await req.arrayBuffer(),
  });
};

describe("fake control API", () => {
  it("seeds accounts and resources, and reports them in state", async () => {
    const email = uniqueEmail("seed");
    const now = Date.UTC(2026, 10, 9, 8, 0, 0);
    const res = await fake.seed({
      accounts: [{ email, sub: "sub-seed" }],
      resources: [{ key: `drive:file:${email}:abc`, value: { id: "abc", name: "Notes" } }],
      now,
    });
    expect(res.accounts).toEqual([email]);
    const state = await fake.state(email);
    expect(state.email).toBe(email);
    expect(state.now).toBe(now);
    expect(state.account).toEqual({ email, sub: "sub-seed" });
    expect(state.resources).toEqual({ [`drive:file:${email}:abc`]: { id: "abc", name: "Notes" } });
  });

  it("rejects malformed seed bodies and resource keys", async () => {
    const bad = await fakeFetch("/__fake/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accounts: [{ email: "not-an-email" }] }),
    });
    expect(bad.status).toBe(400);
    const badKey = await fakeFetch("/__fake/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accounts: [], resources: [{ key: "oauth:rt:x@fake.test:1", value: 1 }] }),
    });
    expect(badKey.status).toBe(400);
  });

  it("resets one account without touching another", async () => {
    const a = uniqueEmail("reset-a");
    const b = uniqueEmail("reset-b");
    await fake.seed({
      accounts: [
        { email: a, sub: "sa" },
        { email: b, sub: "sb" },
      ],
      resources: [
        { key: `drive:file:${a}:1`, value: 1 },
        { key: `drive:file:${b}:1`, value: 1 },
      ],
    });
    await fake.reset(a);
    expect((await fake.state(a)).resources).toEqual({});
    expect((await fake.state(a)).account).toBeUndefined();
    expect((await fake.state(b)).resources).toEqual({ [`drive:file:${b}:1`]: 1 });
  });

  it("injects a fault that fires `times` times for one account, then clears", async () => {
    const email = uniqueEmail("fault");
    const other = uniqueEmail("fault-other");
    await fake.seed({
      accounts: [
        { email, sub: "sf" },
        { email: other, sub: "so" },
      ],
    });
    const mine = await login(viaBinding, email, ["openid", "email"]);
    const theirs = await login(viaBinding, other, ["openid", "email"]);
    await fake.fault({
      email,
      method: "GET",
      pathRegex: "^/openidconnect\\.googleapis\\.com/v1/userinfo$",
      times: 2,
      response: { status: 503, body: { error: { code: 503, message: "injected", status: "UNAVAILABLE" } } },
    });
    const get = (t: string) => fakeFetch(USERINFO, { headers: { authorization: `Bearer ${t}` } });
    expect((await get(theirs.access_token)).status).toBe(200);
    const first = await get(mine.access_token);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: { code: 503, message: "injected", status: "UNAVAILABLE" } });
    expect((await get(mine.access_token)).status).toBe(503);
    expect((await get(mine.access_token)).status).toBe(200);
  });

  it("pads a fault body server-side from a small stored rule", async () => {
    const store = new MemoryStore();
    const app = createFakeGoogle({
      store,
      signingKey: SIGNING_KEY,
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      redirectUris: ["http://localhost/google/callback"],
    });
    const control = (path: string, body: unknown) =>
      app(new Request(`http://fake/__fake/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const email = uniqueEmail("pad");
    expect((await control("seed", { accounts: [{ email, sub: "sp" }] })).status).toBe(200);
    const { access_token } = await login(app, email, ["openid", "email"]);

    const spec = {
      email,
      method: "GET",
      pathRegex: "^/openidconnect\\.googleapis\\.com/v1/userinfo$",
      times: 1,
      response: { status: 200, body: { labels: [] }, padBytes: 5_000_000 },
    };
    const added = await control("faults", spec);
    expect(added.status).toBe(200);
    expect(await added.text()).not.toContain("xxxx");

    const rules = await store.list("fault:rule:");
    expect(rules).toHaveLength(1);
    expect(JSON.stringify(rules[0]?.[1]).length).toBeLessThan(1000);

    const res = await app(new Request(`http://fake${USERINFO}`, { headers: { authorization: `Bearer ${access_token}` } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThanOrEqual(5_000_000);
    const body = JSON.parse(text) as { labels: unknown[]; padding: string };
    expect(body.labels).toEqual([]);
    expect(body.padding).toHaveLength(5_000_000);
    expect(await store.list("fault:rule:")).toHaveLength(0);
  });

  it.each([
    ["over the cap", { status: 200, body: {}, padBytes: 8_000_001 }],
    ["zero", { status: 200, body: {}, padBytes: 0 }],
    ["fractional", { status: 200, body: {}, padBytes: 1.5 }],
    ["a string", { status: 200, body: {}, padBytes: "5000000" }],
    ["a non-object body", { status: 200, body: [1, 2], padBytes: 10 }],
    ["a body that already has padding", { status: 200, body: { padding: "x" }, padBytes: 10 }],
  ])("rejects padBytes %s", async (_label, response) => {
    const res = await fakeFetch("/__fake/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", pathRegex: "^/never$", times: 1, response }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts padBytes at the cap and without a body", async () => {
    for (const response of [{ status: 200, padBytes: 8_000_000 }, { status: 200, body: { a: 1 }, padBytes: 1 }]) {
      const res = await fakeFetch("/__fake/faults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: uniqueEmail("pad-cap"), method: "GET", pathRegex: "^/never$", times: 1, response }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("logs method, path and query only, never bodies or tokens", async () => {
    const email = uniqueEmail("log");
    await fake.seed({ accounts: [{ email, sub: "sl" }] });
    const t = await login(viaBinding, email, ["openid", "email"]);
    await fakeFetch(`${USERINFO}?alt=json`, { headers: { authorization: `Bearer ${t.access_token}` } });
    await fakeFetch("/oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t.refresh_token), {
      method: "POST",
    });
    const log = await fake.requests(email);
    expect(log.map((e) => `${e.method} ${e.path}`)).toEqual([
      "POST /accounts.google.com/o/oauth2/v2/auth/approve",
      "POST /oauth2.googleapis.com/token",
      "GET /openidconnect.googleapis.com/v1/userinfo",
      "POST /oauth2.googleapis.com/revoke",
    ]);
    for (const entry of log) expect(Object.keys(entry).sort()).toEqual(["method", "path", "query", "ts"]);
    expect(log[2]?.query).toEqual({ alt: "json" });
    expect(log[3]?.query).toEqual({ token: "[REDACTED]" });
    const text = JSON.stringify(log);
    for (const leak of ["ya29.", "1//", FAKE_CLIENT_SECRET, "code_verifier", t.access_token]) {
      expect(text).not.toContain(leak);
    }
  });

  it("answers unknown Google routes with a Google-shaped 404", async () => {
    const res = await fakeFetch("/gmail.googleapis.com/gmail/v1/users/me/nothing-here");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: number; message: string; status: string } };
    expect(body.error.code).toBe(404);
    expect(body.error.status).toBe("NOT_FOUND");
    expect(body.error.message).toBeTypeOf("string");
  });

  it("answers unknown control routes with 404", async () => {
    expect((await fakeFetch("/__fake/nothing")).status).toBe(404);
  });
});

describe("fake admin token", () => {
  const app = createFakeGoogle({
    store: new MemoryStore(),
    signingKey: SIGNING_KEY,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    adminToken: "admin-token-for-tests",
    loginSecret: "login-secret-for-tests",
    redirectUris: ["http://localhost/google/callback"],
  });

  it.each([
    ["missing", undefined],
    ["wrong", "admin-token-for-test"],
  ])("rejects a %s admin header", async (_label, header) => {
    const res = await app(
      new Request("http://fake/__fake/state?email=a@fake.test", {
        headers: header ? { "x-fake-admin": header } : {},
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("admin-token-for-tests");
  });

  it("accepts the right admin header", async () => {
    const res = await app(
      new Request("http://fake/__fake/state?email=a@fake.test", { headers: { "x-fake-admin": "admin-token-for-tests" } }),
    );
    expect(res.status).toBe(200);
  });

  it("does not require the admin header on Google routes", async () => {
    const res = await app(new Request("http://fake/openidconnect.googleapis.com/v1/userinfo"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("UNAUTHENTICATED");
  });
});

describe("route access enforcement", () => {
  const seen: Array<{ email: string; now: number }> = [];
  const probe: FakeRoute = {
    method: "GET",
    pattern: /^\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/probe$/,
    scopes: [GMAIL_RO],
    handle(ctx) {
      seen.push({ email: ctx.email, now: ctx.now() });
      return Response.json({ ok: true });
    },
  };
  const app = createFakeGoogle({
    store: new MemoryStore(),
    signingKey: SIGNING_KEY,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    routes: [probe],
  });
  const seedAndLogin = async (email: string, scopes: string[], now?: number) => {
    const seeded = await app(
      new Request("http://fake/__fake/seed", {
        method: "POST",
        body: JSON.stringify({ accounts: [{ email, sub: "s" }], now }),
      }),
    );
    expect(seeded.status).toBe(200);
    return login(app, email, scopes);
  };
  const callProbe = (token?: string) =>
    app(
      new Request("http://fake/gmail.googleapis.com/gmail/v1/users/me/probe", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );

  it("answers 401 without a token", async () => {
    expect((await callProbe()).status).toBe(401);
  });

  it("answers 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT without the route scope", async () => {
    const t = await seedAndLogin("noscope@fake.test", ["openid"]);
    const res = await callProbe(t.access_token);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("passes the token owner and the seeded clock to the handler", async () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const t = await seedAndLogin("scoped@fake.test", [GMAIL_RO], now);
    const res = await callProbe(t.access_token);
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toEqual({ email: "scoped@fake.test", now });
  });
});

describe("fixtures", () => {
  it("loads the default seed fixture", () => {
    const seed = loadSeedFixture("default");
    expect(seed.accounts.length).toBeGreaterThan(0);
    for (const a of seed.accounts) expect(a.email).toMatch(/\.(test|example|invalid)$/);
  });

  it.each(["someone@gmail.com", "a@fake.test.com", "b@example.com"])(
    "refuses to seed %s, which is not under a reserved test TLD",
    async (email) => {
      const res = await fakeFetch("/__fake/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accounts: [{ email, sub: "s-real" }] }),
      });
      expect(res.status).toBe(400);
      expect((await fake.state(email)).account).toBeUndefined();
    },
  );

  it.each(["x@fake.test", "y@corp.example", "z@nowhere.invalid"])("seeds %s under a reserved test TLD", async (email) => {
    const local = uniqueEmail("tld").split("@")[0];
    const addr = `${local}-${email}`;
    const seeded = await fake.seed({ accounts: [{ email: addr, sub: "s-ok" }] });
    expect(seeded.accounts).toEqual([addr]);
  });

  it("validates request/response fixtures", () => {
    const ok = parseFixture({
      id: "gmail-profile",
      source: "synthesized",
      provenance: "Discovery gmail v1 Profile schema",
      request: { method: "GET", path: "/gmail.googleapis.com/gmail/v1/users/me/profile" },
      response: { status: 200, body: { emailAddress: "a@fake.test" } },
    });
    expect(ok.id).toBe("gmail-profile");
    expect(() => parseFixture({ id: "x", source: "guessed", request: {}, response: {} })).toThrow();
  });
});

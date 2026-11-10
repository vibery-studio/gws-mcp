import { beforeAll, describe, expect, it } from "vitest";
import { createFakeGoogle, type FakeGoogleOptions } from "../../fake-google/src/app";
import { MemoryStore } from "../../fake-google/src/store";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "../../src/config";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const REDIRECT = "http://localhost/google/callback";
const AUTH = "/accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "/oauth2.googleapis.com/token";
const REVOKE = "/oauth2.googleapis.com/revoke";
const USERINFO = "/openidconnect.googleapis.com/v1/userinfo";
const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

interface AuthOpts {
  scopes: string[];
  include?: boolean;
  accessType?: "offline" | "online";
  overrides?: Record<string, string | null>;
}

function authParams(email: string, challenge: string, opts: AuthOpts): URLSearchParams {
  const p = new URLSearchParams({
    client_id: FAKE_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: opts.scopes.join(" "),
    state: `st-${crypto.randomUUID()}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: opts.accessType ?? "offline",
    include_granted_scopes: String(opts.include ?? true),
    login_hint: email,
    prompt: "consent",
  });
  for (const [k, v] of Object.entries(opts.overrides ?? {})) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  return p;
}

function form(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

async function approve(params: URLSearchParams, email: string, decision = "allow"): Promise<Response> {
  return fakeFetch(`${AUTH}/approve`, form({ ...Object.fromEntries(params), email, decision }));
}

async function codeFor(email: string, opts: AuthOpts): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = await pkce();
  const params = authParams(email, challenge, opts);
  const res = await approve(params, email);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location") ?? "");
  expect(loc.searchParams.get("state")).toBe(params.get("state"));
  const code = loc.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code ?? "", verifier };
}

async function exchange(code: string, verifier: string, patch: Record<string, string> = {}): Promise<Response> {
  return fakeFetch(
    TOKEN,
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
      ...patch,
    }),
  );
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
}

async function tokensFor(email: string, opts: AuthOpts): Promise<TokenBody> {
  const { code, verifier } = await codeFor(email, opts);
  const res = await exchange(code, verifier);
  expect(res.status).toBe(200);
  return (await res.json()) as TokenBody;
}

function refresh(refreshToken: string, secret = FAKE_CLIENT_SECRET): Promise<Response> {
  return fakeFetch(
    TOKEN,
    form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: FAKE_CLIENT_ID, client_secret: secret }),
  );
}

function userinfo(accessToken: string): Promise<Response> {
  return fakeFetch(USERINFO, { headers: { authorization: `Bearer ${accessToken}` } });
}

const scopesOf = (t: TokenBody) => (t.scope ?? "").split(" ").filter(Boolean).sort();

describe("fake Google OAuth", () => {
  const email = uniqueEmail("oauth");
  const sub = `sub-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await fake.seed({ accounts: [{ email, sub }] });
  });

  describe("authorize page", () => {
    it("renders a picker form with the seeded account", async () => {
      const { challenge } = await pkce();
      const res = await fakeFetch(`${AUTH}?${authParams(email, challenge, { scopes: ["openid", "email"] })}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain(email);
      expect(html).toContain(`action="${AUTH}/approve"`);
      expect(html).toContain('name="decision"');
    });

    it.each([
      ["unknown client_id", { client_id: "someone-else" }],
      ["missing redirect_uri", { redirect_uri: null }],
      ["non-http redirect_uri", { redirect_uri: "javascript:alert(1)" }],
    ])("refuses %s without redirecting", async (_label, overrides) => {
      const { challenge } = await pkce();
      const res = await fakeFetch(`${AUTH}?${authParams(email, challenge, { scopes: ["openid"], overrides })}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    });

    it.each([
      ["wrong response_type", { response_type: "token" }, "unsupported_response_type"],
      ["missing scope", { scope: null }, "invalid_request"],
      ["missing state", { state: null }, "invalid_request"],
      ["missing code_challenge", { code_challenge: null }, "invalid_request"],
      ["plain challenge method", { code_challenge_method: "plain" }, "invalid_request"],
      ["bad access_type", { access_type: "forever" }, "invalid_request"],
      ["bad prompt", { prompt: "always" }, "invalid_request"],
    ])("redirects %s back with an error", async (_label, overrides, error) => {
      const { challenge } = await pkce();
      const res = await fakeFetch(`${AUTH}?${authParams(email, challenge, { scopes: ["openid"], overrides })}`);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(loc.searchParams.get("error")).toBe(error);
    });
  });

  describe("approve", () => {
    it("redirects a denial with access_denied and the state", async () => {
      const { challenge } = await pkce();
      const params = authParams(email, challenge, { scopes: ["openid"] });
      const res = await approve(params, email, "deny");
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.get("state")).toBe(params.get("state"));
      expect(loc.searchParams.get("code")).toBeNull();
    });

    it("refuses an account that was never seeded", async () => {
      const { challenge } = await pkce();
      const res = await approve(authParams(email, challenge, { scopes: ["openid"] }), uniqueEmail("ghost"));
      expect(res.status).toBe(400);
    });

    it("re-validates echoed params on POST", async () => {
      const { challenge } = await pkce();
      const params = authParams(email, challenge, { scopes: ["openid"], overrides: { client_id: "evil" } });
      const res = await approve(params, email);
      expect(res.status).toBe(400);
    });
  });

  describe("token endpoint", () => {
    it("exchanges a code with PKCE for Google-shaped tokens", async () => {
      const t = await tokensFor(email, { scopes: ["openid", "email"] });
      expect(t.access_token).toMatch(/^ya29\.fake-/);
      expect(t.refresh_token).toMatch(/^1\/\/fake-/);
      expect(t.expires_in).toBe(3600);
      expect(t.token_type).toBe("Bearer");
      expect(scopesOf(t)).toEqual(["email", "openid"]);
    });

    it("issues no refresh token for online access", async () => {
      const t = await tokensFor(email, { scopes: ["openid"], accessType: "online" });
      expect(t.access_token).toMatch(/^ya29\.fake-/);
      expect(t.refresh_token).toBeUndefined();
    });

    it("rejects a wrong PKCE verifier", async () => {
      const { code } = await codeFor(email, { scopes: ["openid"] });
      const other = await pkce();
      const res = await exchange(code, other.verifier);
      expect(res.status).toBe(400);
      expect(((await res.json()) as TokenBody).error).toBe("invalid_grant");
    });

    it("rejects a reused code", async () => {
      const { code, verifier } = await codeFor(email, { scopes: ["openid"] });
      expect((await exchange(code, verifier)).status).toBe(200);
      const again = await exchange(code, verifier);
      expect(again.status).toBe(400);
      expect(((await again.json()) as TokenBody).error).toBe("invalid_grant");
    });

    it("rejects a wrong client secret", async () => {
      const { code, verifier } = await codeFor(email, { scopes: ["openid"] });
      const res = await exchange(code, verifier, { client_secret: "not-the-secret" });
      expect(res.status).toBe(401);
      expect(((await res.json()) as TokenBody).error).toBe("invalid_client");
    });

    it("rejects a redirect_uri that differs from the authorize request", async () => {
      const { code, verifier } = await codeFor(email, { scopes: ["openid"] });
      const res = await exchange(code, verifier, { redirect_uri: "http://localhost/other" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as TokenBody).error).toBe("invalid_grant");
    });

    it("rejects a tampered code", async () => {
      const { code, verifier } = await codeFor(email, { scopes: ["openid"] });
      const res = await exchange(`${code.slice(0, -2)}xx`, verifier);
      expect(res.status).toBe(400);
    });

    it("rejects an unsupported grant type", async () => {
      const res = await fakeFetch(
        TOKEN,
        form({ grant_type: "password", client_id: FAKE_CLIENT_ID, client_secret: FAKE_CLIENT_SECRET }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as TokenBody).error).toBe("unsupported_grant_type");
    });

    it("refreshes an access token", async () => {
      const t = await tokensFor(email, { scopes: ["openid", "email"] });
      const res = await refresh(t.refresh_token ?? "");
      expect(res.status).toBe(200);
      const r = (await res.json()) as TokenBody;
      expect(r.access_token).toMatch(/^ya29\.fake-/);
      expect(r.access_token).not.toBe(t.access_token);
      expect(r.refresh_token).toBeUndefined();
      expect(r.expires_in).toBe(3600);
      expect(scopesOf(r)).toEqual(["email", "openid"]);
    });

    it("rejects a refresh with the wrong client secret", async () => {
      const t = await tokensFor(email, { scopes: ["openid"] });
      expect((await refresh(t.refresh_token ?? "", "wrong")).status).toBe(401);
    });

    it("answers invalid_grant for an unknown refresh token", async () => {
      const res = await refresh("1//fake-unknown");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_grant", error_description: expect.any(String) });
    });
  });

  describe("revoke", () => {
    it("revokes the refresh token, its access tokens and the grant", async () => {
      const t = await tokensFor(email, { scopes: ["openid", "email"] });
      expect((await userinfo(t.access_token ?? "")).status).toBe(200);
      const res = await fakeFetch(REVOKE, form({ token: t.refresh_token ?? "" }));
      expect(res.status).toBe(200);
      const after = await refresh(t.refresh_token ?? "");
      expect(after.status).toBe(400);
      expect(((await after.json()) as TokenBody).error).toBe("invalid_grant");
      expect((await userinfo(t.access_token ?? "")).status).toBe(401);
    });

    it("rejects an unknown token", async () => {
      const res = await fakeFetch(REVOKE, form({ token: "1//fake-nothing" }));
      expect(res.status).toBe(400);
    });
  });

  describe("incremental scopes", () => {
    const incEmail = uniqueEmail("incremental");

    beforeAll(async () => {
      await fake.seed({ accounts: [{ email: incEmail, sub: `sub-${crypto.randomUUID()}` }] });
    });

    it("unions earlier grants when include_granted_scopes=true", async () => {
      await tokensFor(incEmail, { scopes: [GMAIL_RO] });
      const t = await tokensFor(incEmail, { scopes: [DRIVE_FILE], include: true });
      expect(scopesOf(t)).toEqual([DRIVE_FILE, GMAIL_RO].sort());
      const r = (await (await refresh(t.refresh_token ?? "")).json()) as TokenBody;
      expect(scopesOf(r)).toEqual([DRIVE_FILE, GMAIL_RO].sort());
    });

    it("returns only the requested scopes when include_granted_scopes=false", async () => {
      const t = await tokensFor(incEmail, { scopes: [DRIVE_FILE], include: false });
      expect(scopesOf(t)).toEqual([DRIVE_FILE]);
    });

    it("starts from the requested scopes again after the grant is revoked", async () => {
      const email = uniqueEmail("incremental-revoked");
      await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}` }] });
      const first = await tokensFor(email, { scopes: [GMAIL_RO, DRIVE_FILE] });
      expect((await fakeFetch(REVOKE, form({ token: first.refresh_token ?? "" }))).status).toBe(200);
      const next = await tokensFor(email, { scopes: [GMAIL_RO], include: true });
      expect(scopesOf(next)).toEqual([GMAIL_RO]);
    });
  });

  describe("granted scopes are per account and client", () => {
    const store = new MemoryStore();
    const OTHER_ID = "another-fake-client";
    const OTHER_SECRET = "another-fake-secret";
    const appFor = (clientId: string, clientSecret: string) =>
      createFakeGoogle({ store, signingKey: "per-client-signing-key", clientId, clientSecret });
    const ours = appFor(FAKE_CLIENT_ID, FAKE_CLIENT_SECRET);
    const theirs = appFor(OTHER_ID, OTHER_SECRET);
    const shared = "per-client@fake.test";

    async function scopesVia(app: typeof ours, clientId: string, clientSecret: string, scopes: string[]): Promise<string[]> {
      const { verifier, challenge } = await pkce();
      const params = authParams(shared, challenge, { scopes, include: true, overrides: { client_id: clientId } });
      const approved = await app(
        new Request(`http://fake${AUTH}/approve`, form({ ...Object.fromEntries(params), email: shared, decision: "allow" })),
      );
      const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const res = await app(
        new Request(
          `http://fake${TOKEN}`,
          form({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        ),
      );
      expect(res.status).toBe(200);
      return scopesOf((await res.json()) as TokenBody);
    }

    beforeAll(async () => {
      const res = await ours(
        new Request("http://fake/__fake/seed", {
          method: "POST",
          body: JSON.stringify({ accounts: [{ email: shared, sub: "sub-per-client" }] }),
        }),
      );
      expect(res.status).toBe(200);
    });

    it("unions only the same client's earlier grant for the account", async () => {
      expect(await scopesVia(theirs, OTHER_ID, OTHER_SECRET, [DRIVE_FILE])).toEqual([DRIVE_FILE]);
      expect(await scopesVia(ours, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, [GMAIL_RO])).toEqual([GMAIL_RO]);
      expect(await scopesVia(ours, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, ["openid"])).toEqual(["openid", GMAIL_RO].sort());
    });
  });

  describe("userinfo and access checks", () => {
    it("returns sub, email and email_verified", async () => {
      const t = await tokensFor(email, { scopes: ["openid", "email"] });
      const res = await userinfo(t.access_token ?? "");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sub, email, email_verified: true });
    });

    it("answers a Google-shaped 401 for an unknown token", async () => {
      const res = await userinfo("ya29.fake-unknown");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      const body = (await res.json()) as { error: { code: number; status: string } };
      expect(body.error.code).toBe(401);
      expect(body.error.status).toBe("UNAUTHENTICATED");
    });

    it("answers 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT when no required scope was granted", async () => {
      const t = await tokensFor(email, { scopes: [DRIVE_FILE], include: false });
      const res = await userinfo(t.access_token ?? "");
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { code: number; status: string; details: Array<{ reason?: string }> };
      };
      expect(body.error.code).toBe(403);
      expect(body.error.status).toBe("PERMISSION_DENIED");
      expect(body.error.details.some((d) => d.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")).toBe(true);
    });
  });
});

describe("redirect URI allowlist", () => {
  const email = uniqueEmail("redirect");

  beforeAll(async () => {
    await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}` }] });
  });

  it.each([
    ["another origin", "http://localhost:8787/google/callback"],
    ["another path", "http://localhost/google/callback2"],
    ["a trailing slash", "http://localhost/google/callback/"],
    ["an added query", "http://localhost/google/callback?next=/x"],
    ["https instead of http", "https://localhost/google/callback"],
  ])("refuses a redirect_uri with %s without redirecting", async (_label, redirectUri) => {
    const { challenge } = await pkce();
    const params = authParams(email, challenge, { scopes: ["openid"], overrides: { redirect_uri: redirectUri } });
    const page = await fakeFetch(`${AUTH}?${params}`);
    expect(page.status).toBe(400);
    expect(page.headers.get("location")).toBeNull();
    expect(await page.text()).toContain("redirect_uri_mismatch");
    const approved = await approve(params, email);
    expect(approved.status).toBe(400);
    expect(approved.headers.get("location")).toBeNull();
  });

  it("accepts the registered redirect_uri exactly", async () => {
    const { code } = await codeFor(email, { scopes: ["openid"] });
    expect(code).toBeTruthy();
  });
});

describe("fake options for a deployed fake", () => {
  const base: FakeGoogleOptions = {
    store: new MemoryStore(),
    signingKey: "options-test-signing-key",
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
  };
  const ADMIN = "admin-token-for-options-test";
  const LOGIN = "login-secret-for-options-test";

  it.each([
    ["without redirectUris", { adminToken: ADMIN, loginSecret: LOGIN }, /redirectUris/],
    ["with an empty redirectUris list", { adminToken: ADMIN, loginSecret: LOGIN, redirectUris: [] }, /redirectUris/],
    ["without a login secret", { adminToken: ADMIN, redirectUris: [REDIRECT] }, /loginSecret/],
    ["with a short login secret", { adminToken: ADMIN, loginSecret: "short", redirectUris: [REDIRECT] }, /loginSecret/],
  ])("refuses an admin token %s", (_label, patch, error) => {
    expect(() => createFakeGoogle({ ...base, ...patch })).toThrow(error);
  });

  it.each([
    ["a relative URI", "/google/callback"],
    ["a non-http scheme", "javascript:alert(1)"],
    ["a fragment", "http://localhost/google/callback#x"],
  ])("refuses a registered redirect URI with %s", (_label, uri) => {
    expect(() => createFakeGoogle({ ...base, redirectUris: [uri] })).toThrow(/redirectUris/);
  });
});

describe("account picker login secret", () => {
  const LOGIN = "login-secret-for-picker-test";
  const email = "picker@fake.test";
  const app = createFakeGoogle({
    store: new MemoryStore(),
    signingKey: "picker-test-signing-key",
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    adminToken: "admin-token-for-picker-test",
    loginSecret: LOGIN,
    redirectUris: [REDIRECT],
  });

  beforeAll(async () => {
    const res = await app(
      new Request("http://fake/__fake/seed", {
        method: "POST",
        headers: { "x-fake-admin": "admin-token-for-picker-test" },
        body: JSON.stringify({ accounts: [{ email, sub: "sub-picker" }] }),
      }),
    );
    expect(res.status).toBe(200);
  });

  const approveWith = async (extra: Record<string, string>) => {
    const { challenge } = await pkce();
    const params = authParams(email, challenge, { scopes: ["openid"] });
    return app(
      new Request(`http://fake${AUTH}/approve`, form({ ...Object.fromEntries(params), email, decision: "allow", ...extra })),
    );
  };

  it("renders a password field on the picker", async () => {
    const { challenge } = await pkce();
    const res = await app(new Request(`http://fake${AUTH}?${authParams(email, challenge, { scopes: ["openid"] })}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('type="password"');
    expect(html).toContain('name="login_secret"');
    expect(html).not.toContain(LOGIN);
  });

  it.each([
    ["missing", {}],
    ["wrong", { login_secret: "login-secret-for-picker-tesT" }],
  ])("refuses approval with a %s login secret and issues no code", async (_label, extra) => {
    const res = await approveWith(extra);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain(LOGIN);
  });

  it("approves with the right login secret", async () => {
    const res = await approveWith({ login_secret: LOGIN });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("code")).toBeTruthy();
  });
});

describe("refresh token issuance follows Google", () => {
  const noPrompt = { prompt: null };

  it("issues a refresh token on the first offline grant, then only with prompt=consent", async () => {
    const email = uniqueEmail("refresh-fidelity");
    await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}` }] });

    const first = await tokensFor(email, { scopes: ["openid", "email"], overrides: noPrompt });
    expect(first.refresh_token).toMatch(/^1\/\/fake-/);

    const again = await tokensFor(email, { scopes: ["openid", "email"], overrides: noPrompt });
    expect(again.access_token).toMatch(/^ya29\.fake-/);
    expect(again.refresh_token).toBeUndefined();

    const selectOnly = await tokensFor(email, { scopes: ["openid"], overrides: { prompt: "select_account" } });
    expect(selectOnly.refresh_token).toBeUndefined();

    const consent = await tokensFor(email, { scopes: ["openid"], overrides: { prompt: "select_account consent" } });
    expect(consent.refresh_token).toMatch(/^1\/\/fake-/);

    // The earlier refresh token keeps working: re-consent adds a token, it does not rotate the old one.
    expect((await refresh(first.refresh_token ?? "")).status).toBe(200);
  });

  it("treats the next grant after a revoke as a first grant", async () => {
    const email = uniqueEmail("refresh-after-revoke");
    await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}` }] });
    const first = await tokensFor(email, { scopes: ["openid"], overrides: noPrompt });
    expect((await fakeFetch(REVOKE, form({ token: first.refresh_token ?? "" }))).status).toBe(200);
    const next = await tokensFor(email, { scopes: ["openid"], overrides: noPrompt });
    expect(next.refresh_token).toMatch(/^1\/\/fake-/);
  });
});

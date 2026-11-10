import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, loadConfig } from "../../src/config";
import { isGwsError, toWire } from "../../src/errors";
import { googleOAuth, type Transport } from "../../src/google/oauth";
import { omitSecrets } from "../../src/runtime/workers/env";
import { authorizeAtFake, fakeTransport, recordingTransport } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "POST https://oauth2.googleapis.com/token";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!isGwsError(e)) throw e;
    return e;
  }
  throw new Error("expected a rejection");
}

async function seeded(prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}` }] });
  return email;
}

/** A transport that answers every call with one canned response and records the requests. */
function cannedTransport(status: number, body: string, contentType = "application/json") {
  const requests: Array<{ url: string; body: string }> = [];
  const transport: Transport = async (url, init) => {
    requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
  return { transport, requests };
}

const googleEnv = { ...env, GOOGLE_UPSTREAM: "google" };

describe("buildAuthUrl", () => {
  const config = loadConfig(env);
  const params = {
    scopes: ["openid", "email", GMAIL_RO, GMAIL_RO],
    state: "state-123",
    codeChallenge: CHALLENGE,
    loginHint: "someone@fake.test",
  };

  it("targets the fake's public auth endpoint in fake mode with offline, incremental, consent and S256", () => {
    const url = new URL(googleOAuth(env, fakeTransport).buildAuthUrl(params));
    expect(`${url.origin}${url.pathname}`).toBe("http://fake-google.test/accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: FAKE_CLIENT_ID,
      redirect_uri: "http://localhost/google/callback",
      response_type: "code",
      scope: `openid email ${GMAIL_RO}`,
      state: "state-123",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      login_hint: "someone@fake.test",
    });
  });

  it("asks for online access with the account chooser, never offline, consent or incremental scopes, when access is online", () => {
    const url = new URL(googleOAuth(env, fakeTransport).buildAuthUrl({ ...params, scopes: ["openid", "email"], access: "online" }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: FAKE_CLIENT_ID,
      redirect_uri: "http://localhost/google/callback",
      response_type: "code",
      scope: "openid email",
      state: "state-123",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "select_account",
      login_hint: "someone@fake.test",
    });
  });

  it("keeps offline access with consent when access is offline", () => {
    const url = new URL(googleOAuth(env, fakeTransport).buildAuthUrl({ ...params, access: "offline" }));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("targets accounts.google.com in google mode with the client id secret and never the client secret", () => {
    const url = new URL(googleOAuth(googleEnv, fakeTransport).buildAuthUrl(params));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id") === env.GOOGLE_CLIENT_ID).toBe(true);
    expect(url.toString().includes(env.GOOGLE_CLIENT_SECRET)).toBe(false);
  });

  it("omits login_hint when none is given", () => {
    const { loginHint: _omit, ...rest } = params;
    const url = new URL(googleOAuth(env, fakeTransport).buildAuthUrl(rest));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  it.each([
    ["no scopes", { scopes: [] }],
    ["an empty state", { state: "" }],
    ["a plain PKCE challenge", { codeChallenge: "too-short" }],
  ])("refuses %s", (_label, patch) => {
    expect(() => googleOAuth(env, fakeTransport).buildAuthUrl({ ...params, ...patch })).toThrow(/invalid/);
  });

  it("always sends the configured callback as redirect_uri, ignoring any caller-supplied one", () => {
    const smuggled = { ...params, redirectUri: "https://attacker.example/cb" };
    for (const e of [env, googleEnv]) {
      const url = new URL(googleOAuth(e, fakeTransport).buildAuthUrl(smuggled));
      expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    }
    expect(config.redirectUri).toBe(`${config.PUBLIC_BASE_URL}/google/callback`);
  });
});

describe("code exchange against the fake", () => {
  it("returns access and refresh tokens and parses the granted scope string into a set", async () => {
    const email = await seeded("oauth-exchange");
    const grant = await authorizeAtFake({ email, scopes: ["openid", "email", GMAIL_RO, DRIVE_FILE] });
    const tokens = await googleOAuth(env, fakeTransport).exchangeCode(grant);
    expect(tokens.accessToken.startsWith("ya29.")).toBe(true);
    expect(tokens.refreshToken?.startsWith("1//")).toBe(true);
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.scopes).toEqual(["email", "openid", DRIVE_FILE, GMAIL_RO].sort());
  });

  it("returns no refresh token for an online-access request, even on the account's first grant", async () => {
    const email = await seeded("oauth-online");
    const oauth = googleOAuth(env, fakeTransport);
    const codeVerifier = "v".repeat(43);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const authUrl = new URL(oauth.buildAuthUrl({ scopes: ["openid", "email"], state: "st-online", codeChallenge: challenge, access: "online" }));
    const res = await fakeFetch(`${authUrl.pathname}/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(authUrl.searchParams), email, decision: "allow" }).toString(),
    });
    const code = new URL(res.headers.get("location") ?? "http://x").searchParams.get("code") ?? "";
    const tokens = await oauth.exchangeCode({ code, codeVerifier });
    expect(tokens.accessToken.startsWith("ya29.")).toBe(true);
    expect(tokens.refreshToken).toBeUndefined();
  });

  it("returns no refresh token when the user re-consents without prompt=consent", async () => {
    const email = await seeded("oauth-reconsent");
    const oauth = googleOAuth(env, fakeTransport);
    await oauth.exchangeCode(await authorizeAtFake({ email, scopes: ["openid", "email"] }));
    const again = await oauth.exchangeCode(
      await authorizeAtFake({ email, scopes: [GMAIL_RO], withoutConsentPrompt: true }),
    );
    expect(again.refreshToken).toBeUndefined();
    expect(again.scopes).toEqual(["email", "openid", GMAIL_RO].sort());
  });

  it("sends the fake client credentials in fake mode, never the real client secret", async () => {
    const { transport, requests } = cannedTransport(
      200,
      JSON.stringify({ access_token: "ya29.x", expires_in: 3600, token_type: "Bearer", scope: "email" }),
    );
    await googleOAuth(env, transport).exchangeCode({ code: "c", codeVerifier: "v" });
    const form = new URLSearchParams(requests[0]?.body);
    expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(form.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(form.get("client_secret")).toBe(FAKE_CLIENT_SECRET);
    expect(requests[0]?.body.includes(env.GOOGLE_CLIENT_SECRET)).toBe(false);
  });

  it("exchanges the code with the configured callback as redirect_uri, ignoring any caller-supplied one", async () => {
    const { transport, requests } = cannedTransport(
      200,
      JSON.stringify({ access_token: "ya29.x", expires_in: 3600, token_type: "Bearer", scope: "email" }),
    );
    const smuggled = { code: "c", codeVerifier: "v", redirectUri: "https://attacker.example/cb" };
    await googleOAuth(env, transport).exchangeCode(smuggled);
    expect(new URLSearchParams(requests[0]?.body).get("redirect_uri")).toBe(loadConfig(env).redirectUri);
  });

  it("sends the configured client secret only in google mode", async () => {
    const { transport, requests } = cannedTransport(
      200,
      JSON.stringify({ access_token: "ya29.x", expires_in: 3600, token_type: "Bearer", scope: "email" }),
    );
    await googleOAuth(googleEnv, transport).refresh("1//stored");
    const form = new URLSearchParams(requests[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id") === env.GOOGLE_CLIENT_ID).toBe(true);
    expect(form.get("client_secret") === env.GOOGLE_CLIENT_SECRET).toBe(true);
  });

  it("maps a reused code to an upstream error, not to reconnect", async () => {
    const email = await seeded("oauth-reuse");
    const oauth = googleOAuth(env, fakeTransport);
    const grant = await authorizeAtFake({ email, scopes: ["openid"] });
    await oauth.exchangeCode(grant);
    const err = await rejection(oauth.exchangeCode(grant));
    expect(err.code).toBe("GWS_UPSTREAM_ERROR");
    expect(err.details).toEqual({ status: 400, oauthError: "invalid_grant" });
  });
});

describe("refresh against the fake", () => {
  it("mints a new access token from a stored refresh token", async () => {
    const email = await seeded("oauth-refresh");
    const oauth = googleOAuth(env, fakeTransport);
    const first = await oauth.exchangeCode(await authorizeAtFake({ email, scopes: ["openid", "email", GMAIL_RO] }));
    const next = await oauth.refresh(first.refreshToken ?? "");
    expect(next.accessToken.startsWith("ya29.")).toBe(true);
    expect(next.accessToken).not.toBe(first.accessToken);
    expect(next.refreshToken).toBeUndefined();
    expect(next.scopes).toEqual(["email", "openid", GMAIL_RO].sort());
  });

  it("maps invalid_grant after a revoke to GWS_RECONNECT_REQUIRED with exactly one token call and no token in the error", async () => {
    const email = await seeded("oauth-revoked");
    const first = await googleOAuth(env, fakeTransport).exchangeCode(await authorizeAtFake({ email, scopes: ["openid"] }));
    const refreshToken = first.refreshToken ?? "";
    await googleOAuth(env, fakeTransport).revoke(refreshToken);

    const { transport, calls } = recordingTransport();
    const err = await rejection(googleOAuth(env, transport).refresh(refreshToken));
    expect(err.code).toBe("GWS_RECONNECT_REQUIRED");
    expect(calls).toEqual([TOKEN_URL]);
    const wire = JSON.stringify(toWire(err));
    expect(wire.includes(refreshToken)).toBe(false);
    expect(wire.includes("1//")).toBe(false);
  });

  it.each([
    ["a server error", 500, "<html>oops</html>", "text/html"],
    ["an unexpected OAuth error", 401, JSON.stringify({ error: "invalid_client", error_description: "Unauthorized" }), "application/json"],
    ["a token response missing the access token", 200, JSON.stringify({ expires_in: 3600, token_type: "Bearer" }), "application/json"],
    ["a non-JSON success body", 200, "ya29.leaked-in-body", "text/plain"],
  ])("maps %s to GWS_UPSTREAM_ERROR with one call and no body text", async (_label, status, body, type) => {
    const { transport, requests } = cannedTransport(status, body, type);
    const err = await rejection(googleOAuth(env, transport).refresh("1//stored-token"));
    expect(err.code).toBe("GWS_UPSTREAM_ERROR");
    expect(requests).toHaveLength(1);
    const wire = JSON.stringify(toWire(err));
    expect(wire.includes("oops")).toBe(false);
    expect(wire.includes("ya29.")).toBe(false);
    expect(wire.includes("1//stored-token")).toBe(false);
  });

  it("maps a transport failure to GWS_UPSTREAM_ERROR without its message", async () => {
    const failing: Transport = async () => {
      throw new Error("connect failed for 1//stored-token");
    };
    const err = await rejection(googleOAuth(env, failing).refresh("1//stored-token"));
    expect(err.code).toBe("GWS_UPSTREAM_ERROR");
    expect(err.message.includes("1//")).toBe(false);
  });
});

describe("userinfo and revoke against the fake", () => {
  it("returns the account's sub and email", async () => {
    const email = uniqueEmail("oauth-userinfo");
    const sub = `sub-${crypto.randomUUID()}`;
    await fake.seed({ accounts: [{ email, sub }] });
    const oauth = googleOAuth(env, fakeTransport);
    const tokens = await oauth.exchangeCode(await authorizeAtFake({ email, scopes: ["openid", "email"] }));
    expect(await oauth.userinfo(tokens.accessToken)).toEqual({ sub, email });
  });

  it("rejects an invalid access token with an upstream error", async () => {
    const err = await rejection(googleOAuth(env, fakeTransport).userinfo("ya29.not-a-real-token"));
    expect(err.code).toBe("GWS_UPSTREAM_ERROR");
    expect(JSON.stringify(toWire(err)).includes("ya29.")).toBe(false);
  });

  it("refuses an unverified email", async () => {
    const { transport } = cannedTransport(200, JSON.stringify({ sub: "1", email: "x@fake.test", email_verified: false }));
    expect((await rejection(googleOAuth(env, transport).userinfo("ya29.x"))).code).toBe("GWS_UPSTREAM_ERROR");
  });

  it("revokes the grant, and revoking an already revoked token still succeeds", async () => {
    const email = await seeded("oauth-revoke");
    const oauth = googleOAuth(env, fakeTransport);
    const tokens = await oauth.exchangeCode(await authorizeAtFake({ email, scopes: ["openid", "email"] }));
    await oauth.revoke(tokens.refreshToken ?? "");
    expect((await fake.state(email)).grants).toEqual({});
    await expect(oauth.revoke(tokens.refreshToken ?? "")).resolves.toBeUndefined();
  });
});

describe("OAuth env type", () => {
  it("does not accept the secret-stripped host env", () => {
    const host = omitSecrets(env);
    // Never invoked: the assertion is the compile error below.
    const make = () =>
      // @ts-expect-error the OAuth client needs the Google client secrets the host env deliberately lacks
      googleOAuth(host, fakeTransport);
    expect(typeof make).toBe("function");
  });
});

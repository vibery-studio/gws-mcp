// The MCP OAuth authorization server, end to end, as an AI app and a person see it. Shared by the Workers tests
// (test/auth/oauth-conformance.test.ts, the Worker entry in-process) and the Node host tests
// (test/node-host/oauth.test.ts, the built bundle over HTTP): the same cases assert the same answers on both, so the
// Node host serves exactly the provider the Worker does. Only the plumbing differs per target (how a request reaches
// the server, how a person signs in, how an admin changes the access list, where OAUTH_KV lives).
import { describe, expect, it } from "vitest";

/** The one redirect URI conformance clients register. */
export const CLIENT_REDIRECT = "https://oauth-conformance.example/callback";

export interface ConformanceBrowser {
  /** A same-site request with this browser's cookies; redirects are not followed. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  postForm(path: string, fields: Array<[string, string]>): Promise<Response>;
}

/** The part of a KV namespace the checks read. */
export interface KvLister {
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface OAuthTarget {
  /** The public origin (PUBLIC_BASE_URL); every URL the server publishes must be on it. */
  base: string;
  /** One request as an AI app sends it: no cookies, redirects not followed. `path` starts with `/`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Seeds `email` at the fake Google (default preset) and signs it in; the caller has allowed it. */
  signIn(email: string): Promise<ConformanceBrowser>;
  /** Adds an exact user rule for `email` through this target's admin path. */
  allow(email: string): Promise<void>;
  /** Removes the exact rule for `email` through this target's admin path. */
  remove(email: string): Promise<void>;
  /** The provider's KV namespace (OAUTH_KV). */
  oauthKv: KvLister;
  /** A domain no access rule covers, so only the exact rules these checks add allow its people. */
  domain: string;
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function hidden(html: string, name: string): string {
  const m = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html);
  if (!m?.[1]) throw new Error(`the page has no hidden ${name}`);
  return m[1].replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d))).replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** The account checkbox whose label starts with `email`. */
function accountId(html: string, email: string): string {
  const found = [...html.matchAll(/<label><input type="checkbox" name="account" value="([^"]*)"(?: checked)?> ([^<]*)<\/label>/g)].find(
    (m) => (m[2] ?? "").split(" ")[0] === email,
  );
  if (!found?.[1]) throw new Error("the consent page does not list the account");
  return found[1];
}

/** The `userId:grantId:secret` shape of the provider's codes and tokens. */
function grantOf(credential: string): { userId: string; grantId: string } {
  const [userId = "", grantId = ""] = credential.split(":");
  return { userId, grantId };
}

export function oauthConformance(targetName: string, target: () => OAuthTarget): void {
  const t = () => target();
  let seq = 0;
  const unique = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@${t().domain}`;

  async function json(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }

  async function register(body: Record<string, unknown> = {}): Promise<Response> {
    return t().fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "OAuth conformance client",
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...body,
      }),
    });
  }

  async function registerClient(): Promise<string> {
    const res = await register();
    const body = await json(res);
    if (res.status !== 201 || typeof body.client_id !== "string") throw new Error(`registration: ${res.status}`);
    return body.client_id;
  }

  function authorizePath(clientId: string, challenge: string, state: string, overrides: Record<string, string | null> = {}): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      scope: "gws",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${t().base}/mcp`,
    });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) q.delete(name);
      else q.set(name, value);
    }
    return `/authorize?${q.toString()}`;
  }

  function tokenRequest(fields: Record<string, string>): Promise<Response> {
    return t().fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /** Registers a client, opens its consent page and approves `email`'s account; returns the code and the verifier. */
  async function consent(browser: ConformanceBrowser, email: string): Promise<{ clientId: string; code: string; verifier: string; state: string }> {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();
    const state = crypto.randomUUID();
    const page = await browser.fetch(authorizePath(clientId, challenge, state));
    const html = await page.text();
    expect(page.status).toBe(200);
    const approved = await browser.postForm("/authorize", [
      ["handle", hidden(html, "handle")],
      ["csrf", hidden(html, "csrf")],
      ["decision", "approve"],
      ["account", accountId(html, email)],
    ]);
    await approved.body?.cancel();
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("state")).toBe(state);
    const code = location.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    return { clientId, code, verifier, state };
  }

  function exchange(clientId: string, code: string, verifier: string | null, redirectUri = CLIENT_REDIRECT): Promise<Response> {
    return tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      ...(verifier === null ? {} : { code_verifier: verifier }),
      resource: `${t().base}/mcp`,
    });
  }

  function refresh(clientId: string, refreshToken: string): Promise<Response> {
    return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: `${t().base}/mcp` });
  }

  /** One JSON-RPC call over Streamable HTTP; the status, and the last message when the call was answered. */
  async function rpc(accessToken: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; message?: Record<string, unknown> }> {
    const res = await t().fetch("/mcp", {
      method: "POST",
      // The Host a real client sends (an in-process Request has none; the MCP handler checks it).
      headers: { ...MCP_HEADERS, host: new URL(t().base).host, authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
    });
    const text = await res.text();
    if (res.status !== 200) return { status: res.status };
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .at(-1);
    return { status: res.status, message: JSON.parse(data ?? text) as Record<string, unknown> };
  }

  async function toolsListStatus(accessToken: string): Promise<number> {
    return (await rpc(accessToken, "tools/list")).status;
  }

  /** A person allowed by an exact rule, signed in, with an approved client and its first tokens. */
  async function approvedClient(label: string) {
    const email = unique(label);
    await t().allow(email);
    const browser = await t().signIn(email);
    const c = await consent(browser, email);
    const res = await exchange(c.clientId, c.code, c.verifier);
    expect(res.status).toBe(200);
    const body = await json(res);
    return { email, browser, ...c, tokens: body, accessToken: String(body.access_token), refreshToken: String(body.refresh_token) };
  }

  async function errorOf(res: Response): Promise<{ status: number; error: unknown }> {
    const body = await json(res);
    return { status: res.status, error: body.error };
  }

  describe(`OAuth on ${targetName}`, () => {
    it("publishes the authorization server metadata on the public origin, whatever Host the request names", async () => {
      const res = await t().fetch("/.well-known/oauth-authorization-server", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
      expect(res.status).toBe(200);
      const meta = await json(res);
      const base = t().base;
      expect(meta).toMatchObject({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: expect.arrayContaining(["authorization_code", "refresh_token"]),
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["gws"],
        client_id_metadata_document_supported: false,
      });
      expect(JSON.stringify(meta)).not.toContain("evil.example");
    });

    it("sends Google the callback on the public origin, whatever Host the request names", async () => {
      const res = await t().fetch("/login", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
      await res.body?.cancel();
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe(`${t().base}/google/callback`);
    });

    it("publishes the protected resource metadata, and a 401 without a token points at it", async () => {
      const base = t().base;
      const res = await t().fetch("/.well-known/oauth-protected-resource/mcp", { headers: { host: "evil.example" } });
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });

      const unauth = await t().fetch("/mcp", { method: "POST", headers: { ...MCP_HEADERS, host: new URL(base).host }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      await unauth.body?.cancel();
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    });

    it("registers a public client dynamically, and refuses a redirect URI that is not a web address", async () => {
      const res = await register();
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(typeof body.client_id).toBe("string");
      expect(body).toMatchObject({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" });
      expect(body.client_secret).toBeUndefined();

      const refused = await register({ redirect_uris: ["javascript:alert(1)"] });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toBe("invalid_client_metadata");
    });

    it("refuses a client id metadata document URL as a client: CIMD is off", async () => {
      const email = unique("cimd");
      await t().allow(email);
      const browser = await t().signIn(email);
      const { challenge, verifier } = await pkce();
      const cimd = "https://cimd-client.example/oauth/client.json";
      for (const who of [browser, { fetch: t().fetch }]) {
        const res = await who.fetch(authorizePath(cimd, challenge, "s", { redirect_uri: "https://cimd-client.example/callback" }));
        await res.body?.cancel();
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
      }
      const token = await tokenRequest({ grant_type: "authorization_code", code: "u:g:s", redirect_uri: "https://cimd-client.example/callback", client_id: cimd, code_verifier: verifier });
      expect((await errorOf(token)).error).toBe("invalid_client");
    }, 30_000);

    it("runs the whole flow: consent, code, PKCE token, tools/list and an execute over Streamable HTTP, with the configured TTLs", async () => {
      const c = await approvedClient("flow");
      expect(c.tokens).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: "gws" });
      expect(typeof c.tokens.refresh_token).toBe("string");

      const list = await rpc(c.accessToken, "tools/list");
      expect(list.status).toBe(200);
      const tools = ((list.message?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((x) => x.name).sort();
      expect(tools).toEqual(["execute", "search"]);

      const run = await rpc(c.accessToken, "tools/call", { name: "execute", arguments: { code: `async () => (await sdk.gmail.users.labels.list({ userId: "me" })).labels.length` } });
      expect(run.status).toBe(200);
      const content = (run.message?.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text ?? "{}";
      const out = JSON.parse(content) as { result?: unknown; error?: unknown; calls?: Array<Record<string, unknown>> };
      expect(out.error).toBeUndefined();
      expect(typeof out.result).toBe("number");
      expect(out.calls?.[0]).toMatchObject({ fn: "gmail.users.labels.list", status: "ok", account: c.email });

      // TTLs as stored: the access token for an hour, the grant (and so its refresh token) for 30 days.
      const now = Date.now() / 1000;
      const { userId, grantId } = grantOf(c.accessToken);
      const tokens = await t().oauthKv.list({ prefix: `token:${userId}:${grantId}:` });
      expect(tokens.keys).toHaveLength(1);
      expect(tokens.keys[0]?.expiration).toBeGreaterThan(now + 3600 - 120);
      expect(tokens.keys[0]?.expiration).toBeLessThanOrEqual(now + 3600 + 5);
      const grants = await t().oauthKv.list({ prefix: `grant:${userId}:` });
      const grant = grants.keys.find((k) => k.name === `grant:${userId}:${grantId}`);
      expect(grant?.metadata).toMatchObject({ clientId: c.clientId });
      expect(grant?.expiration).toBeGreaterThan(now + 30 * 86400 - 120);
      expect(grant?.expiration).toBeLessThanOrEqual(now + 30 * 86400 + 120);

      // A code works once.
      expect(await errorOf(await exchange(c.clientId, c.code, c.verifier))).toEqual({ status: 400, error: "invalid_grant" });
    }, 60_000);

    it("rotates the refresh token, keeping only the previous one until the new one is used", async () => {
      const c = await approvedClient("refresh");
      const first = await refresh(c.clientId, c.refreshToken);
      expect(first.status).toBe(200);
      const one = await json(first);
      expect(one).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: "gws" });
      expect(one.refresh_token).not.toBe(c.refreshToken);
      expect(one.access_token).not.toBe(c.accessToken);
      expect(await toolsListStatus(String(one.access_token))).toBe(200);

      const second = await refresh(c.clientId, String(one.refresh_token));
      expect(second.status).toBe(200);
      const two = await json(second);
      expect(await toolsListStatus(String(two.access_token))).toBe(200);
      // The original is two rotations old now.
      expect(await errorOf(await refresh(c.clientId, c.refreshToken))).toEqual({ status: 400, error: "invalid_grant" });
      // A refresh token works only for its own client.
      const other = await registerClient();
      expect((await errorOf(await refresh(other, String(two.refresh_token)))).status).toBe(400);
    }, 60_000);

    it("revokes an access token and a refresh token at the token endpoint (RFC 7009)", async () => {
      const c = await approvedClient("revoke");
      expect(await toolsListStatus(c.accessToken)).toBe(200);
      const revokeAccess = await tokenRequest({ token: c.accessToken, client_id: c.clientId });
      await revokeAccess.body?.cancel();
      expect(revokeAccess.status).toBe(200);
      expect(await toolsListStatus(c.accessToken)).toBe(401);

      const revokeRefresh = await tokenRequest({ token: c.refreshToken, client_id: c.clientId });
      await revokeRefresh.body?.cancel();
      expect(revokeRefresh.status).toBe(200);
      expect(await errorOf(await refresh(c.clientId, c.refreshToken))).toEqual({ status: 400, error: "invalid_grant" });
    }, 60_000);

    it("requires S256 PKCE: refuses a wrong or missing verifier, a plain challenge and a request without one", async () => {
      const email = unique("pkce");
      await t().allow(email);
      const browser = await t().signIn(email);

      const wrong = await consent(browser, email);
      expect(await errorOf(await exchange(wrong.clientId, wrong.code, (await pkce()).verifier))).toEqual({ status: 400, error: "invalid_grant" });
      const missing = await consent(browser, email);
      expect(await errorOf(await exchange(missing.clientId, missing.code, null))).toEqual({ status: 400, error: "invalid_request" });

      const clientId = await registerClient();
      const { challenge } = await pkce();
      const refusedChallenges: Array<Record<string, string | null>> = [{ code_challenge_method: "plain" }, { code_challenge: null, code_challenge_method: null }];
      for (const overrides of refusedChallenges) {
        const res = await browser.fetch(authorizePath(clientId, challenge, "s", overrides));
        await res.body?.cancel();
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get("location") ?? "");
        expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
        expect(location.searchParams.get("error")).toBe("invalid_request");
        expect(location.searchParams.get("code")).toBeNull();
      }
    }, 60_000);

    it("refuses a redirect URI the client did not register, at /authorize and at the token endpoint", async () => {
      const email = unique("redirect");
      await t().allow(email);
      const browser = await t().signIn(email);
      const clientId = await registerClient();
      const { challenge } = await pkce();
      const res = await browser.fetch(authorizePath(clientId, challenge, "s", { redirect_uri: "https://evil.example/callback" }));
      await res.body?.cancel();
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();

      const c = await consent(browser, email);
      expect(await errorOf(await exchange(c.clientId, c.code, c.verifier, "https://evil.example/callback"))).toEqual({ status: 400, error: "invalid_grant" });
      // A code works only for the client it was issued to.
      expect(await errorOf(await exchange(clientId, c.code, c.verifier))).toEqual({ status: 400, error: "invalid_grant" });
    }, 60_000);

    it("sends a denial back to the app as access_denied, with no code", async () => {
      const email = unique("deny");
      await t().allow(email);
      const browser = await t().signIn(email);
      const clientId = await registerClient();
      const { challenge } = await pkce();
      const page = await browser.fetch(authorizePath(clientId, challenge, "deny-state"));
      const html = await page.text();
      const denied = await browser.postForm("/authorize", [
        ["handle", hidden(html, "handle")],
        ["csrf", hidden(html, "csrf")],
        ["decision", "deny"],
      ]);
      await denied.body?.cancel();
      expect(denied.status).toBe(302);
      const location = new URL(denied.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
      expect(location.searchParams.get("error")).toBe("access_denied");
      expect(location.searchParams.get("state")).toBe("deny-state");
      expect(location.searchParams.get("code")).toBeNull();
    }, 30_000);

    it("ends an AI app's access at once when the person's access rule is removed, and a re-add revives nothing", async () => {
      const c = await approvedClient("removed");
      expect(await toolsListStatus(c.accessToken)).toBe(200);
      await t().remove(c.email);
      expect(await toolsListStatus(c.accessToken)).toBe(401);
      expect(await errorOf(await refresh(c.clientId, c.refreshToken))).toEqual({ status: 400, error: "invalid_grant" });
      await t().allow(c.email);
      expect(await toolsListStatus(c.accessToken)).toBe(401);
    }, 60_000);
  });
}

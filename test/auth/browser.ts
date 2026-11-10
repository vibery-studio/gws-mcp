import { env, exports } from "cloudflare:workers";
import { loadConfig } from "../../src/config";
import { fake, fakeFetch } from "../helpers/fake";

/** Shared helpers for the sign-in and consent tests: a browser with a manual cookie jar, a fake Google picker, an MCP client. */

export const config = loadConfig(env);
export const BASE = config.PUBLIC_BASE_URL;
export const CLIENT_REDIRECT = "https://mcp-client.example/callback";

/** A browser: follows nothing on its own, keeps cookies by name (attributes are asserted separately). */
export class Browser {
  readonly cookies = new Map<string, string>();

  /** `worker` answers the requests; by default the real Worker entry. */
  constructor(private readonly worker: (request: Request) => Promise<Response> = (r) => exports.default.fetch(r)) {}

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await this.worker(new Request(new URL(url, BASE).toString(), { ...init, headers, redirect: "manual" }));
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(eq + 1).trim());
    }
    return res;
  }

  postForm(url: string, fields: Array<[string, string]>): Promise<Response> {
    return this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /** Names of cookies whose name starts with `prefix`. */
  cookieNames(prefix: string): string[] {
    return [...this.cookies.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** Seeds a fake Google account with a unique sub. */
export async function seedGoogle(email: string, sub = `${Date.now()}${Math.floor(Math.random() * 1e9)}`): Promise<string> {
  await fake.seed({ accounts: [{ email, sub }] });
  return sub;
}

/** Picks `email` on the fake Google page the auth URL points to; returns the callback URL Google redirects to. */
export async function pickAtFake(authUrl: string, email: string, decision: "allow" | "deny" = "allow"): Promise<string> {
  const url = new URL(authUrl);
  const res = await fakeFetch(`${url.pathname}/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(url.searchParams), email, decision }).toString(),
  });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) throw new Error(`fake picker failed: ${res.status}`);
  return location;
}

/** Starts /login and returns the Google auth URL it redirected to. */
export async function startLogin(browser: Browser, next?: string): Promise<URL> {
  const res = await browser.fetch(next === undefined ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) throw new Error(`login did not redirect: ${res.status}`);
  return new URL(location);
}

/** Signs in with Google as `email` and returns the login callback response, before any follow-up. */
export async function loginCallback(browser: Browser, email: string, next?: string): Promise<Response> {
  const authUrl = await startLogin(browser, next);
  return browser.fetch(await pickAtFake(authUrl.toString(), email));
}

/** True when a response sends the browser to the (fake) Google consent page. */
export function redirectsToGoogle(res: Response): boolean {
  return res.status === 302 && (res.headers.get("location") ?? "").startsWith(`${config.FAKE_GOOGLE_PUBLIC_URL}/`);
}

/**
 * Signs in with Google as `email`. A first sign-in continues straight into connecting the account; that
 * round trip is completed as the same account. Returns the last callback response (302 to `next` on success).
 */
export async function signIn(browser: Browser, email: string, next?: string): Promise<Response> {
  const res = await loginCallback(browser, email, next);
  if (!redirectsToGoogle(res)) return res;
  return browser.fetch(await pickAtFake(res.headers.get("location") ?? "", email));
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Registers a public MCP client through dynamic client registration. */
export async function registerClient(clientName: string): Promise<string> {
  const res = await exports.default.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { client_id?: unknown };
  if (typeof body.client_id !== "string") throw new Error("registration returned no client_id");
  return body.client_id;
}

/** An authorization request path; `overrides` replace (or, with null, drop) single parameters. */
export function authorizePath(clientId: string, challenge: string, state: string, overrides: Record<string, string | null> = {}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    scope: "gws",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: config.mcpResource,
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) q.delete(name);
    else q.set(name, value);
  }
  return `/authorize?${q.toString()}`;
}

export interface ConsentForm {
  handle: string;
  csrf: string;
  accounts: Array<{ id: string; label: string; checked: boolean }>;
}

const unescape = (s: string) =>
  s.replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d))).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Reads the hidden fields and account checkboxes of the consent page. */
export function parseConsent(page: string): ConsentForm {
  const hidden = (name: string) => {
    const m = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(page);
    if (!m?.[1]) throw new Error(`consent page has no ${name}`);
    return unescape(m[1]);
  };
  const accounts = [...page.matchAll(/<label><input type="checkbox" name="account" value="([^"]*)"( checked)?> ([^<]*)<\/label>/g)].map((m) => ({
    id: unescape(m[1] ?? ""),
    label: unescape(m[3] ?? ""),
    checked: m[2] !== undefined,
  }));
  return { handle: hidden("handle"), csrf: hidden("csrf"), accounts };
}

/** Exchanges an authorization code at /oauth/token with the PKCE verifier. */
export async function exchangeCode(clientId: string, code: string, verifier: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: config.mcpResource,
    }).toString(),
  });
}

/** One JSON-RPC `tools/list` to /mcp with a bearer token; returns the HTTP status. */
export async function mcpToolsList(accessToken?: string): Promise<number> {
  const res = await exports.default.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      host: new URL(BASE).host,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  await res.body?.cancel();
  return res.status;
}

export interface ApprovedClient {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
}

/**
 * Runs the whole consent dance for a signed-in browser: register, /authorize, approve with `accountIds`,
 * exchange the code. Returns the client and its access token.
 */
export async function approveClient(
  browser: Browser,
  clientName: string,
  accountIds: (form: ConsentForm) => string[],
  overrides: Record<string, string | null> = {},
): Promise<ApprovedClient & { scope: unknown }> {
  const clientId = await registerClient(clientName);
  const { verifier, challenge } = await pkce();
  const page = await browser.fetch(authorizePath(clientId, challenge, crypto.randomUUID(), overrides));
  if (page.status !== 200) throw new Error(`consent page failed: ${page.status}`);
  const form = parseConsent(await page.text());
  const approved = await browser.postForm("/authorize", [
    ["handle", form.handle],
    ["csrf", form.csrf],
    ["decision", "approve"],
    ...accountIds(form).map((id): [string, string] => ["account", id]),
  ]);
  const location = approved.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (approved.status !== 302 || !code) throw new Error(`approve failed: ${approved.status}`);
  const token = await exchangeCode(clientId, code, verifier);
  const body = (await token.json()) as { access_token?: unknown; refresh_token?: unknown; scope?: unknown };
  if (typeof body.access_token !== "string") throw new Error("token exchange returned no access_token");
  return {
    clientId,
    accessToken: body.access_token,
    scope: body.scope,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
  };
}

/** The user's default account on the consent page (nothing is pre-checked there). */
export function defaultAccount(form: ConsentForm): string[] {
  return form.accounts.filter((a) => a.label.includes("(default)")).map((a) => a.id);
}

/** The user a browser's sign-in created: `u_<sub>`. */
export function userIdFor(sub: string): string {
  return `u_${sub}`;
}

/** Account ids of the user's D1 client allowlist rows for `clientId`. */
export async function grantRows(userId: string, clientId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT account_id FROM client_grants WHERE user_id = ? AND client_id = ? ORDER BY account_id")
    .bind(userId, clientId)
    .all<{ account_id: string }>();
  return results.map((r) => r.account_id);
}

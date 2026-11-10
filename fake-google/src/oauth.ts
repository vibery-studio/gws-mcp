import { EMAIL_RE, fakeKey, type FakeStore, type JsonValue } from "./store";

// ---------- encoding and crypto helpers (Web Crypto only) ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function randomToken(bytes = 24): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length differences still return false). */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

// ---------- Google-shaped responses ----------

export function googleError(
  status: number,
  message: string,
  googleStatus: string,
  extra: { details?: JsonValue[]; errors?: JsonValue[]; headers?: Record<string, string> } = {},
): Response {
  const error: Record<string, JsonValue> = { code: status, message, status: googleStatus };
  if (extra.errors) error.errors = extra.errors;
  if (extra.details) error.details = extra.details;
  return Response.json({ error }, { status, headers: extra.headers });
}

function oauthError(status: number, error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function htmlError(status: number, message: string): Response {
  return new Response(page("Error", `<h1>Error ${status}</h1><p>${escapeHtml(message)}</p>`), {
    status,
    headers: htmlHeaders(),
  });
}

function htmlHeaders(): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

// ---------- state ----------

export const AUTH_PATH = "/accounts.google.com/o/oauth2/v2/auth";
export const APPROVE_PATH = `${AUTH_PATH}/approve`;
export const TOKEN_PATH = "/oauth2.googleapis.com/token";
export const REVOKE_PATH = "/oauth2.googleapis.com/revoke";
export const USERINFO_PATH = "/openidconnect.googleapis.com/v1/userinfo";

const ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 5 * 60 * 1000;
const USERINFO_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/userinfo.email"];

export interface FakeAccount {
  [key: string]: JsonValue;
  email: string;
  sub: string;
}

/** Token record, keyed by the SHA-256 of the token; plaintext tokens are never stored. */
interface TokenRecord {
  [key: string]: JsonValue;
  kind: "access" | "refresh";
  email: string;
  clientId: string;
  scopes: string[];
  /** Access tokens only: expiry in ms. */
  exp: number;
  /** Access tokens only: hash of the refresh token that minted it, or "". */
  refreshHash: string;
}

export const accountKey = (email: string) => fakeKey("oauth", "account", email, "profile");
export const grantKey = (email: string, clientId: string) => fakeKey("oauth", "grant", email, clientId);
const codeKey = (email: string, jti: string) => fakeKey("oauth", "code", email, jti);
export const TOKEN_PREFIX = "oauth:token:";
const tokenKey = (hash: string) => `${TOKEN_PREFIX}${hash}`;

export function getAccount(store: FakeStore, email: string): Promise<FakeAccount | undefined> {
  return store.get<FakeAccount>(accountKey(email));
}

async function issueToken(
  store: FakeStore,
  kind: TokenRecord["kind"],
  base: { email: string; clientId: string; scopes: string[] },
  refreshHash = "",
): Promise<{ token: string; hash: string }> {
  const token = kind === "access" ? `ya29.fake-${randomToken()}` : `1//fake-${randomToken()}`;
  const hash = await sha256Hex(token);
  const record: TokenRecord = {
    kind,
    ...base,
    exp: kind === "access" ? Date.now() + ACCESS_TTL_S * 1000 : 0,
    refreshHash,
  };
  await store.put(tokenKey(hash), record);
  return { token, hash };
}

async function findToken(store: FakeStore, token: string): Promise<TokenRecord | undefined> {
  if (!token || token.length > 512) return undefined;
  return store.get<TokenRecord>(tokenKey(await sha256Hex(token)));
}

/** Revokes every token of one account for one client, and the grant itself (Google revokes the whole grant). */
async function revokeGrant(store: FakeStore, email: string, clientId: string): Promise<void> {
  for (const [key, rec] of await store.list<TokenRecord>(TOKEN_PREFIX)) {
    if (rec.email === email && rec.clientId === clientId) await store.delete(key);
  }
  await store.delete(grantKey(email, clientId));
}

/** Resolves a bearer token to its owner without checking scopes (used for logs and fault matching). */
export async function bearerOwner(store: FakeStore, req: Request): Promise<string | undefined> {
  const token = bearerToken(req);
  if (!token) return undefined;
  const rec = await findToken(store, token);
  return rec?.kind === "access" && rec.exp > Date.now() ? rec.email : undefined;
}

function bearerToken(req: Request): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m?.[1];
}

export type AccessResult =
  | { ok: true; email: string; scopes: string[] }
  | { ok: false; response: Response };

/**
 * Google-style access check for API routes: a valid, unexpired access token holding any one of `anyOfScopes`
 * (no scope needed when the list is empty). Fails with Google's 401 / 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT.
 */
export async function requireAccess(
  ctx: { req: Request; store: FakeStore },
  anyOfScopes: readonly string[],
): Promise<AccessResult> {
  const token = bearerToken(ctx.req);
  const rec = token ? await findToken(ctx.store, token) : undefined;
  if (!rec || rec.kind !== "access" || rec.exp <= Date.now()) {
    return {
      ok: false,
      response: googleError(
        401,
        "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
        "UNAUTHENTICATED",
        {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: token ? "ACCESS_TOKEN_EXPIRED" : "CREDENTIALS_MISSING",
              domain: "googleapis.com",
            },
          ],
          headers: { "www-authenticate": 'Bearer realm="https://accounts.google.com/", error="invalid_token"' },
        },
      ),
    };
  }
  if (anyOfScopes.length > 0 && !anyOfScopes.some((s) => rec.scopes.includes(s))) {
    return {
      ok: false,
      response: googleError(403, "Request had insufficient authentication scopes.", "PERMISSION_DENIED", {
        errors: [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }],
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
            domain: "googleapis.com",
          },
        ],
        headers: {
          "www-authenticate": `Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="${anyOfScopes.join(" ")}"`,
        },
      }),
    };
  }
  return { ok: true, email: rec.email, scopes: rec.scopes };
}

// ---------- authorize parameter validation ----------

interface AuthParams {
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
  accessType: "online" | "offline";
  includeGranted: boolean;
  loginHint?: string;
  prompt?: string;
}

type AuthCheck =
  | { kind: "ok"; p: AuthParams }
  /** Client or redirect URI cannot be trusted: show an error page, never redirect. */
  | { kind: "fatal"; message: string }
  | { kind: "redirect"; redirectUri: string; state: string | null; error: string; description: string };

const ECHOED = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "access_type",
  "include_granted_scopes",
  "login_hint",
  "prompt",
] as const;

const PROMPTS = new Set(["none", "consent", "select_account"]);

function checkAuthParams(p: URLSearchParams | FormData, deps: Pick<OAuthDeps, "clientId" | "redirectUris">): AuthCheck {
  const get = (k: string): string | null => {
    const v = p.get(k);
    return typeof v === "string" ? v : null;
  };
  if (!safeEqual(get("client_id") ?? "", deps.clientId)) {
    return { kind: "fatal", message: "invalid_client: unknown OAuth client" };
  }
  const redirectUri = get("redirect_uri");
  let parsed: URL | undefined;
  try {
    parsed = redirectUri ? new URL(redirectUri) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!redirectUri || !parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.hash) {
    return { kind: "fatal", message: "redirect_uri_mismatch: invalid redirect_uri" };
  }
  // Like Google: an unregistered redirect URI gets an error page, never a redirect (no open redirector).
  if (deps.redirectUris !== undefined && !deps.redirectUris.has(redirectUri)) {
    return { kind: "fatal", message: "redirect_uri_mismatch: redirect_uri is not registered for this client" };
  }
  const state = get("state");
  const fail = (error: string, description: string): AuthCheck => ({
    kind: "redirect",
    redirectUri,
    state,
    error,
    description,
  });
  if (get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  const scopes = [...new Set((get("scope") ?? "").split(/\s+/).filter(Boolean))];
  if (scopes.length === 0 || scopes.length > 50 || scopes.some((s) => s.length > 256 || /[\x00-\x20"\\]/.test(s))) {
    return fail("invalid_request", "missing or invalid scope");
  }
  if (!state || state.length > 2048) return fail("invalid_request", "missing state");
  const challenge = get("code_challenge");
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const accessType = get("access_type") ?? "online";
  if (accessType !== "online" && accessType !== "offline") return fail("invalid_request", "invalid access_type");
  const include = get("include_granted_scopes") ?? "false";
  if (include !== "true" && include !== "false") return fail("invalid_request", "invalid include_granted_scopes");
  const prompt = get("prompt") ?? undefined;
  if (prompt !== undefined) {
    const parts = prompt.split(" ");
    if (parts.some((x) => !PROMPTS.has(x)) || (parts.includes("none") && parts.length > 1)) {
      return fail("invalid_request", "invalid prompt");
    }
  }
  const loginHint = get("login_hint") ?? undefined;
  const out: AuthParams = { redirectUri, scopes, state, challenge, accessType, includeGranted: include === "true" };
  if (loginHint) out.loginHint = loginHint;
  if (prompt) out.prompt = prompt;
  return { kind: "ok", p: out };
}

function redirectWith(redirectUri: string, params: Record<string, string | null>): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
}

function authCheckFailure(check: Exclude<AuthCheck, { kind: "ok" }>): Response {
  if (check.kind === "fatal") return htmlError(400, check.message);
  return redirectWith(check.redirectUri, {
    error: check.error,
    error_description: check.description,
    state: check.state,
  });
}

// ---------- authorization codes (HMAC-signed, single use) ----------

interface CodePayload {
  jti: string;
  email: string;
  clientId: string;
  scopes: string[];
  redirectUri: string;
  challenge: string;
  /** Whether the exchange returns a refresh token (decided at consent time, as Google does). */
  issueRefresh: boolean;
  exp: number;
}

async function signCode(key: CryptoKey, payload: CodePayload): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

async function verifyCode(key: CryptoKey, code: string): Promise<CodePayload | undefined> {
  const [body, sig, extra] = code.split(".");
  if (!body || !sig || extra !== undefined || code.length > 4096) return undefined;
  const sigBytes = b64urlDecode(sig);
  if (!sigBytes || !(await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body)))) return undefined;
  const raw = b64urlDecode(body);
  if (!raw) return undefined;
  try {
    return JSON.parse(dec.decode(raw)) as CodePayload;
  } catch {
    return undefined;
  }
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return safeEqual(b64urlEncode(digest), challenge);
}

// ---------- endpoint handlers ----------

export interface OAuthDeps {
  store: FakeStore;
  signingKey: Promise<CryptoKey>;
  clientId: string;
  clientSecret: string;
  /** Exact-match redirect URI allowlist; any http(s) URI when undefined. */
  redirectUris: ReadonlySet<string> | undefined;
  /** Password the account picker requires before approving; no password when undefined. */
  loginSecret: string | undefined;
  /** Lets handlers attribute the request log entry to an account. */
  setLogEmail(email: string): void;
}

/** Handles the fake OAuth endpoints; returns undefined when `path` is not one of them. */
export async function handleOAuth(req: Request, url: URL, path: string, deps: OAuthDeps): Promise<Response | undefined> {
  const route = `${req.method} ${path}`;
  switch (route) {
    case `GET ${AUTH_PATH}`:
      return authorizePage(url.searchParams, deps);
    case `POST ${APPROVE_PATH}`:
      return approve(req, deps);
    case `POST ${TOKEN_PATH}`:
      return token(req, deps);
    case `POST ${REVOKE_PATH}`:
      return revoke(req, url, deps);
    case `GET ${USERINFO_PATH}`:
    case `POST ${USERINFO_PATH}`:
      return userinfo(req, deps);
    default:
      return undefined;
  }
}

async function authorizePage(params: URLSearchParams, deps: OAuthDeps): Promise<Response> {
  const check = checkAuthParams(params, deps);
  if (check.kind !== "ok") return authCheckFailure(check);
  const accounts = (await deps.store.list<FakeAccount>("oauth:account:")).map(([, a]) => a);
  if (check.p.loginHint && EMAIL_RE.test(check.p.loginHint)) deps.setLogEmail(check.p.loginHint);
  const hidden = ECHOED.map((k) => {
    const v = params.get(k);
    return v === null ? "" : `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
  }).join("");
  const choices = accounts
    .map(
      (a) =>
        `<label><input type="radio" name="email" value="${escapeHtml(a.email)}"${a.email === check.p.loginHint ? " checked" : ""}> ${escapeHtml(a.email)}</label><br>`,
    )
    .join("");
  const body =
    `<h1>Fake Google: choose an account</h1>` +
    `<p>Requested scopes: ${escapeHtml(check.p.scopes.join(" "))}</p>` +
    `<form method="post" action="${APPROVE_PATH}">${hidden}${choices || "<p>No seeded accounts.</p>"}` +
    (deps.loginSecret === undefined
      ? ""
      : `<label>Login secret <input type="password" name="login_secret" autocomplete="current-password" required></label><br>`) +
    `<button type="submit" name="decision" value="allow">Allow</button> ` +
    `<button type="submit" name="decision" value="deny">Cancel</button></form>`;
  return new Response(page("Fake Google sign-in", body), { status: 200, headers: htmlHeaders() });
}

async function readForm(req: Request): Promise<FormData | undefined> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(type)) return undefined;
  try {
    return await req.formData();
  } catch {
    return undefined;
  }
}

function formString(f: FormData, k: string): string {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
}

async function approve(req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await readForm(req);
  if (!form) return htmlError(400, "invalid_request: form body required");
  const check = checkAuthParams(form, deps);
  if (check.kind !== "ok") return authCheckFailure(check);
  if (deps.loginSecret !== undefined && !safeEqual(formString(form, "login_secret"), deps.loginSecret)) {
    return htmlError(401, "invalid login secret");
  }
  const { p } = check;
  const email = formString(form, "email");
  const account = EMAIL_RE.test(email) ? await getAccount(deps.store, email) : undefined;
  if (!account) return htmlError(400, "unknown account");
  deps.setLogEmail(email);
  const decision = formString(form, "decision");
  if (decision === "deny") return redirectWith(p.redirectUri, { error: "access_denied", state: p.state });
  if (decision !== "allow") return htmlError(400, "invalid_request: decision must be allow or deny");

  const grant = await deps.store.get<{ scopes: string[] }>(grantKey(email, deps.clientId));
  const previous = grant?.scopes ?? [];
  const union = [...new Set([...previous, ...p.scopes])];
  // Google returns a refresh token only on the first grant for (account, client) or on explicit re-consent.
  const consent = p.prompt?.split(" ").includes("consent") ?? false;
  const issueRefresh = p.accessType === "offline" && (grant === undefined || consent);
  await deps.store.put(grantKey(email, deps.clientId), { scopes: union });
  const scopes = p.includeGranted ? union : p.scopes;
  const code = await signCode(await deps.signingKey, {
    jti: randomToken(16),
    email,
    clientId: deps.clientId,
    scopes,
    redirectUri: p.redirectUri,
    challenge: p.challenge,
    issueRefresh,
    exp: Date.now() + CODE_TTL_MS,
  });
  return redirectWith(p.redirectUri, { code, state: p.state, scope: scopes.join(" ") });
}

/** Client authentication via HTTP Basic or the form body. */
function clientAuthenticated(req: Request, form: FormData, deps: OAuthDeps): boolean {
  let id = formString(form, "client_id");
  let secret = formString(form, "client_secret");
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (basic?.[1]) {
    const raw = b64urlDecode(basic[1].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    const pair = raw ? dec.decode(raw) : "";
    const sep = pair.indexOf(":");
    if (sep < 0) return false;
    try {
      id = decodeURIComponent(pair.slice(0, sep));
      secret = decodeURIComponent(pair.slice(sep + 1));
    } catch {
      return false;
    }
  }
  return safeEqual(id, deps.clientId) && safeEqual(secret, deps.clientSecret);
}

function tokenResponse(body: Record<string, JsonValue>): Response {
  return Response.json(body, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
}

async function token(req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await readForm(req);
  if (!form) return oauthError(400, "invalid_request", "form body required");
  if (!clientAuthenticated(req, form, deps)) return oauthError(401, "invalid_client", "Unauthorized");
  const grantType = formString(form, "grant_type");

  if (grantType === "authorization_code") {
    const code = formString(form, "code");
    const verifier = formString(form, "code_verifier");
    const redirectUri = formString(form, "redirect_uri");
    if (!code || !verifier || !redirectUri) return oauthError(400, "invalid_request", "missing parameter");
    const payload = await verifyCode(await deps.signingKey, code);
    if (!payload) return oauthError(400, "invalid_grant", "Malformed auth code.");
    deps.setLogEmail(payload.email);
    if (payload.exp <= Date.now()) return oauthError(400, "invalid_grant", "Auth code expired.");
    if (!safeEqual(payload.clientId, deps.clientId)) return oauthError(400, "invalid_grant", "Bad Request");
    if (payload.redirectUri !== redirectUri) return oauthError(400, "invalid_grant", "redirect_uri mismatch");
    if (!(await pkceMatches(verifier, payload.challenge))) return oauthError(400, "invalid_grant", "Invalid code verifier.");
    const used = codeKey(payload.email, payload.jti);
    if (await deps.store.get(used)) return oauthError(400, "invalid_grant", "Auth code already used.");
    await deps.store.put(used, { usedAt: Date.now() });
    if (!(await getAccount(deps.store, payload.email))) return oauthError(400, "invalid_grant", "Account removed.");

    const base = { email: payload.email, clientId: payload.clientId, scopes: payload.scopes };
    const refresh = payload.issueRefresh === true ? await issueToken(deps.store, "refresh", base) : undefined;
    const access = await issueToken(deps.store, "access", base, refresh?.hash ?? "");
    const body: Record<string, JsonValue> = {
      access_token: access.token,
      expires_in: ACCESS_TTL_S,
      scope: payload.scopes.join(" "),
      token_type: "Bearer",
    };
    if (refresh) body.refresh_token = refresh.token;
    return tokenResponse(body);
  }

  if (grantType === "refresh_token") {
    const refreshToken = formString(form, "refresh_token");
    const rec = await findToken(deps.store, refreshToken);
    if (!rec || rec.kind !== "refresh" || !safeEqual(rec.clientId, deps.clientId)) {
      return oauthError(400, "invalid_grant", "Token has been expired or revoked.");
    }
    deps.setLogEmail(rec.email);
    if (!(await getAccount(deps.store, rec.email))) return oauthError(400, "invalid_grant", "Token has been expired or revoked.");
    const access = await issueToken(
      deps.store,
      "access",
      { email: rec.email, clientId: rec.clientId, scopes: rec.scopes },
      await sha256Hex(refreshToken),
    );
    return tokenResponse({
      access_token: access.token,
      expires_in: ACCESS_TTL_S,
      scope: rec.scopes.join(" "),
      token_type: "Bearer",
    });
  }

  return oauthError(400, "unsupported_grant_type", "Invalid grant_type");
}

async function revoke(req: Request, url: URL, deps: OAuthDeps): Promise<Response> {
  const form = await readForm(req);
  const tokenValue = (form ? formString(form, "token") : "") || url.searchParams.get("token") || "";
  const rec = await findToken(deps.store, tokenValue);
  if (!rec || (rec.kind === "access" && rec.exp <= Date.now())) {
    return oauthError(400, "invalid_token", "Token expired or revoked");
  }
  deps.setLogEmail(rec.email);
  await revokeGrant(deps.store, rec.email, rec.clientId);
  return Response.json({}, { headers: { "cache-control": "no-store" } });
}

async function userinfo(req: Request, deps: OAuthDeps): Promise<Response> {
  const access = await requireAccess({ req, store: deps.store }, USERINFO_SCOPES);
  if (!access.ok) return access.response;
  const account = await getAccount(deps.store, access.email);
  if (!account) return googleError(401, "Account removed.", "UNAUTHENTICATED");
  return Response.json({ sub: account.sub, email: account.email, email_verified: true });
}

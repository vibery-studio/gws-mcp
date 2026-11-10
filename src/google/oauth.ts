import { z } from "zod";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, loadConfig, requireSecret, type Config, type ConfigEnv } from "../config";
import type { SecretSource } from "../core/ports";
import { GwsError, isGwsError } from "../errors";
import type { Transport } from "./transport";

/** Upstream HTTP seam: the compat-layer transport (real fetch in google mode, the fake binding in fake mode). */
export type { Transport };

/** Real Google endpoints. Server-side calls always name these; the transport maps them in fake mode. */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * The client needs the Google client secrets (google mode), so the secret-stripped `HostEnv` does not
 * type-check here. Fake mode never reads them: the real secret never reaches the fake.
 */
export type OAuthEnv = ConfigEnv & { readonly GOOGLE_CLIENT_ID: string; readonly GOOGLE_CLIENT_SECRET: string };

export interface TokenSet {
  accessToken: string;
  expiresIn: number;
  /** Granted scopes, deduplicated and sorted. */
  scopes: string[];
  /** Present on a first consent or explicit re-consent only; keep the stored one when absent. */
  refreshToken?: string;
}

export interface GoogleUser {
  sub: string;
  /** Lowercased, verified email. */
  email: string;
}

export interface AuthUrlParams {
  scopes: readonly string[];
  state: string;
  /** base64url SHA-256 of the PKCE verifier. */
  codeChallenge: string;
  loginHint?: string;
  /**
   * `offline` (default, connecting an account): a refresh token, re-consent and the whole granted scope set.
   * `online` (sign-in): no refresh token and the account chooser instead of the consent screen. Google keeps
   * 100 refresh tokens per account and client, so tokens minted at sign-in would evict the stored one.
   */
  access?: "online" | "offline";
}

/** The redirect URI is always the configured callback (`config.redirectUri`); callers never choose it. */
export interface CodeExchange {
  code: string;
  codeVerifier: string;
}

export interface GoogleOAuth {
  /** `redirect_uri` is always `config.redirectUri` (PUBLIC_BASE_URL + /google/callback). */
  buildAuthUrl(p: AuthUrlParams): string;
  exchangeCode(p: CodeExchange): Promise<TokenSet>;
  /** `invalid_grant` (revoked or expired grant) fails with GWS_RECONNECT_REQUIRED. Never retried. */
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Revokes the whole Google grant. An already invalid token counts as revoked. */
  revoke(token: string): Promise<void>;
  userinfo(accessToken: string): Promise<GoogleUser>;
}

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_ERROR_RE = /^[a-z_]{1,64}$/;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
});

const UserinfoResponse = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(320).includes("@"),
  email_verified: z.boolean().optional(),
});

/** Splits an OAuth `scope` string into a sorted, deduplicated list. */
export function parseScopes(scope: string | undefined): string[] {
  return [...new Set((scope ?? "").split(/\s+/).filter(Boolean))].sort();
}

/** A secret from `secrets`, or GWS_INTERNAL naming it (never its value) when it is not set. Read on each use. */
function secret(secrets: SecretSource, name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET"): string {
  return requireSecret({ [name]: secrets.get(name) }, name);
}

function clientCredentials(secrets: SecretSource, config: Config): { id: string; secret: string } {
  if (config.GOOGLE_UPSTREAM === "fake") return { id: FAKE_CLIENT_ID, secret: FAKE_CLIENT_SECRET };
  return { id: secret(secrets, "GOOGLE_CLIENT_ID"), secret: secret(secrets, "GOOGLE_CLIENT_SECRET") };
}

function invalid(what: string): GwsError {
  return new GwsError("GWS_INTERNAL", `invalid OAuth request: ${what}`);
}

function upstream(message: string, details: Record<string, unknown>, cause?: unknown): GwsError {
  return new GwsError("GWS_UPSTREAM_ERROR", message, cause === undefined ? { details } : { details, cause });
}

/** Parses a JSON body; undefined when it is not JSON. The body text itself never reaches an error. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text()) as unknown;
  } catch {
    return undefined;
  }
}

/** The OAuth `error` code of a failed token response, only when it has the shape of one. */
function oauthErrorCode(body: unknown): string | undefined {
  const code = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof code === "string" && OAUTH_ERROR_RE.test(code) ? code : undefined;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Google OAuth client. Credentials come from config: fake constants in fake mode, Worker secrets in google mode. */
export function googleOAuth(env: OAuthEnv, transport: Transport): GoogleOAuth {
  const secrets: SecretSource = {
    // Only the two client secrets: the type alone does not stop a caller asking for another env key.
    get: (name) => (name === "GOOGLE_CLIENT_ID" || name === "GOOGLE_CLIENT_SECRET" ? env[name] : undefined),
  };
  return createGoogleOAuth(loadConfig(env), secrets, transport);
}

/**
 * Google OAuth client over a runtime's ports: fake constants in fake mode, `secrets` in google mode. `transport`
 * must target the upstream `config` names, or google-mode credentials would reach the fake.
 */
export function createGoogleOAuth(config: Config, secrets: SecretSource, transport: Transport): GoogleOAuth {
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await transport(url, init);
    } catch (e) {
      if (isGwsError(e)) throw e;
      throw upstream("Google OAuth endpoint unreachable", { endpoint: new URL(url).pathname }, e);
    }
  }

  async function tokenRequest(fields: Record<string, string>, purpose: "exchange" | "refresh"): Promise<TokenSet> {
    const client = clientCredentials(secrets, config);
    const res = await send(GOOGLE_TOKEN_URL, form({ ...fields, client_id: client.id, client_secret: client.secret }));
    const body = await readJson(res);
    if (!res.ok) {
      const oauthError = oauthErrorCode(body);
      if (purpose === "refresh" && oauthError === "invalid_grant") {
        throw new GwsError("GWS_RECONNECT_REQUIRED", "the Google grant was revoked or expired; reconnect the account", {
          details: { status: res.status, oauthError },
        });
      }
      throw upstream(
        "Google token endpoint refused the request",
        oauthError === undefined ? { status: res.status } : { status: res.status, oauthError },
      );
    }
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw upstream("Google token endpoint returned an unexpected response", { status: res.status });
    const t = parsed.data;
    const out: TokenSet = { accessToken: t.access_token, expiresIn: t.expires_in, scopes: parseScopes(t.scope) };
    if (t.refresh_token !== undefined) out.refreshToken = t.refresh_token;
    return out;
  }

  return {
    buildAuthUrl(p) {
      const scopes = [...new Set(p.scopes)];
      if (scopes.length === 0 || scopes.some((s) => s.length === 0 || /\s/.test(s))) throw invalid("scopes");
      if (p.state.length === 0) throw invalid("state");
      if (!PKCE_CHALLENGE_RE.test(p.codeChallenge)) throw invalid("code challenge");

      const base =
        config.GOOGLE_UPSTREAM === "fake" ? `${config.FAKE_GOOGLE_PUBLIC_URL}/accounts.google.com/o/oauth2/v2/auth` : GOOGLE_AUTH_URL;
      const url = new URL(base);
      const q = url.searchParams;
      q.set("client_id", clientCredentials(secrets, config).id);
      q.set("redirect_uri", config.redirectUri);
      q.set("response_type", "code");
      q.set("scope", scopes.join(" "));
      q.set("state", p.state);
      q.set("code_challenge", p.codeChallenge);
      q.set("code_challenge_method", "S256");
      if (p.access === "online") {
        q.set("access_type", "online");
        q.set("prompt", "select_account");
      } else {
        q.set("access_type", "offline");
        q.set("include_granted_scopes", "true");
        q.set("prompt", "consent");
      }
      if (p.loginHint) q.set("login_hint", p.loginHint);
      return url.toString();
    },

    exchangeCode(p) {
      return tokenRequest(
        { grant_type: "authorization_code", code: p.code, code_verifier: p.codeVerifier, redirect_uri: config.redirectUri },
        "exchange",
      );
    },

    refresh(refreshToken) {
      return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, "refresh");
    },

    async revoke(token) {
      const res = await send(GOOGLE_REVOKE_URL, form({ token }));
      if (res.ok) return;
      const oauthError = oauthErrorCode(await readJson(res));
      if (res.status === 400 && oauthError === "invalid_token") return;
      throw upstream(
        "Google revoke endpoint refused the request",
        oauthError === undefined ? { status: res.status } : { status: res.status, oauthError },
      );
    },

    async userinfo(accessToken) {
      const res = await send(GOOGLE_USERINFO_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
      if (!res.ok) throw upstream("Google userinfo endpoint refused the request", { status: res.status });
      const parsed = UserinfoResponse.safeParse(await readJson(res));
      if (!parsed.success) throw upstream("Google userinfo endpoint returned an unexpected response", { status: res.status });
      if (parsed.data.email_verified !== true) throw upstream("Google account email is not verified", { status: res.status });
      return { sub: parsed.data.sub, email: parsed.data.email.toLowerCase() };
    },
  };
}

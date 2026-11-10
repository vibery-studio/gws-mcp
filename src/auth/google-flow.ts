import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { loadConfig } from "../config";
import { googleOAuth, type GoogleOAuth } from "../google/oauth";
import { createTransport } from "../google/transport";
import { b64url, isRandomToken, randomToken, safeEqual, sha256Hex, type AppContext } from "./session";

/** Cookie name without its prefix; browsers receive `__Host-gws_gstate`. */
export const GSTATE_COOKIE = "gws_gstate";
const STATE_TTL_SECONDS = 600;
const STATE_KEY_PREFIX = "gstate:";
/** Scopes every Google round trip asks for: the callback always reads the account's sub and email. */
const IDENTITY_SCOPES = ["openid", "email"] as const;

/** Where sign-in lands when no other page asked for it: Home. */
export const DEFAULT_NEXT = "/";
const MAX_NEXT = 2048;
const MAX_CODE = 4096;
/** Backslashes (browsers read `/\host` as `//host`) and control or format characters. */
const UNSAFE_PATH_CHARS = /[\\\p{Cc}\p{Cf}]/u;

export type GooglePurpose = "login" | "connect";

export interface StartGoogleAuthOptions {
  purpose: GooglePurpose;
  /** Required for `connect`: the signed-in user the new account joins. */
  userId?: string;
  scopes: readonly string[];
  loginHint?: string;
  /** A same-origin path (see `safeNext`). */
  next: string;
}

export interface GoogleAuthResult {
  purpose: GooglePurpose;
  userId?: string;
  email: string;
  sub: string;
  /** The granted set from the token response, unchanged. */
  scopes: string[];
  /** Stored by connect only; sign-in ignores it even if Google returned one. */
  refreshToken?: string;
  next: string;
}

/** Why a Google callback was refused. Each reason is rendered as a page; none reveals stored state. */
export type GoogleFlowFailure = "state" | "denied" | "code";

export class GoogleFlowError extends Error {
  constructor(readonly reason: GoogleFlowFailure) {
    super(`google sign-in refused: ${reason}`);
    this.name = "GoogleFlowError";
  }
}

const StateRecord = z.object({
  purpose: z.enum(["login", "connect"]),
  userId: z.string().min(1).optional(),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  next: z.string(),
  scopes: z.array(z.string()),
  exp: z.number().int(),
});
type StateRecord = z.output<typeof StateRecord>;

/**
 * A redirect target after sign-in: only a path on this origin. A value starting with exactly one "/" and
 * holding no backslash or control character can only resolve to this origin; anything else (absolute or
 * scheme-relative URLs, relative paths, overlong values) falls back to `DEFAULT_NEXT`.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NEXT) return DEFAULT_NEXT;
  if (!value.startsWith("/") || value.startsWith("//") || UNSAFE_PATH_CHARS.test(value)) return DEFAULT_NEXT;
  return value;
}

async function stateKey(state: string): Promise<string> {
  return `${STATE_KEY_PREFIX}${await sha256Hex(state)}`;
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** The Google OAuth client; in fake mode its calls go through the FAKE_GOOGLE binding with the fake credentials. */
function oauthClient(c: AppContext): GoogleOAuth {
  return googleOAuth(c.env, createTransport(c.env, loadConfig(c.env)));
}

const COOKIE_OPTIONS = { prefix: "host", httpOnly: true, sameSite: "Lax" } as const;

/**
 * Starts a Google round trip: a random `state` (stored hashed in KV for 10 minutes and bound to this
 * browser by the `__Host-gws_gstate` cookie) and a PKCE verifier, then a 302 to Google. Sign-in asks for
 * online access (no refresh token); connect asks for offline access with consent. The redirect URI is
 * always the configured callback; it is never derived from the request.
 */
export async function startGoogleAuth(c: AppContext, opts: StartGoogleAuthOptions): Promise<Response> {
  if (opts.purpose === "connect" && !opts.userId) throw new TypeError("a connect round trip needs the signed-in user");
  if (safeNext(opts.next) !== opts.next) throw new TypeError("next must be a same-origin path");

  const state = randomToken();
  const verifier = randomToken();
  const scopes = [...new Set([...IDENTITY_SCOPES, ...opts.scopes])];
  const record: StateRecord = {
    purpose: opts.purpose,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    verifier,
    next: opts.next,
    scopes,
    exp: Date.now() + STATE_TTL_SECONDS * 1000,
  };
  const url = oauthClient(c).buildAuthUrl({
    scopes,
    state,
    codeChallenge: await s256(verifier),
    access: opts.purpose === "login" ? "online" : "offline",
    ...(opts.loginHint ? { loginHint: opts.loginHint } : {}),
  });
  await c.env.CACHE_KV.put(await stateKey(state), JSON.stringify(record), { expirationTtl: STATE_TTL_SECONDS });
  setCookie(c, GSTATE_COOKIE, state, { ...COOKIE_OPTIONS, maxAge: STATE_TTL_SECONDS });
  return c.redirect(url, 302);
}

/**
 * Revokes a refresh token the callback received and will not store, so a refused connection leaves no live
 * Google grant behind. Google revokes the whole grant of that account for this OAuth client, so the caller must
 * not use it when a stored token shares the grant. Best effort: the refusal stands either way, and a failed
 * revoke leaves only what not revoking would.
 */
export async function revokeUnusedToken(c: AppContext, refreshToken: string): Promise<void> {
  await oauthClient(c)
    .revoke(refreshToken)
    .catch(() => undefined);
}

/**
 * Finishes the round trip at /google/callback. The `state` in the query must equal this browser's cookie
 * and name an unexpired stored record; the record is deleted on first use. Only then is a Google error
 * reported or the code exchanged (with the stored PKCE verifier) and the account's identity read.
 */
export async function finishGoogleAuth(c: AppContext, now = Date.now()): Promise<GoogleAuthResult> {
  const cookieState = getCookie(c, GSTATE_COOKIE, "host");
  const queryState = c.req.query("state");
  // A forged callback (another site linking here) must not even clear this browser's pending sign-in.
  if (!isRandomToken(cookieState) || !isRandomToken(queryState) || !safeEqual(cookieState, queryState)) {
    throw new GoogleFlowError("state");
  }
  deleteCookie(c, GSTATE_COOKIE, COOKIE_OPTIONS);

  const key = await stateKey(queryState);
  const raw = await c.env.CACHE_KV.get(key);
  if (raw === null) throw new GoogleFlowError("state");
  await c.env.CACHE_KV.delete(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GoogleFlowError("state");
  }
  const r = StateRecord.safeParse(parsed);
  if (!r.success || r.data.exp <= now) throw new GoogleFlowError("state");
  const record = r.data;
  if (record.purpose === "connect" && record.userId === undefined) throw new GoogleFlowError("state");

  if (c.req.query("error") !== undefined) throw new GoogleFlowError("denied");
  const code = c.req.query("code");
  if (!code || code.length > MAX_CODE) throw new GoogleFlowError("code");

  const oauth = oauthClient(c);
  const tokens = await oauth.exchangeCode({ code, codeVerifier: record.verifier });
  const who = await oauth.userinfo(tokens.accessToken);
  return {
    purpose: record.purpose,
    ...(record.userId !== undefined ? { userId: record.userId } : {}),
    email: who.email,
    sub: who.sub,
    scopes: tokens.scopes,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    next: record.next,
  };
}

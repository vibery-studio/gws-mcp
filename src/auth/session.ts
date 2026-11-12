import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { userRoleOrNull } from "./access";

/** Every web route runs with the full Worker env (the OAuth provider adds its helpers to it). */
export type AppContext = Context<{ Bindings: Env }>;

/** Cookie name without its prefix; browsers receive `__Host-gws_session` (Secure, Path=/, no Domain). */
export const SESSION_COOKIE = "gws_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_KEY_PREFIX = "sess:";

export interface Session {
  userId: string;
  /** Per-session CSRF token: every state-changing form posts it back. */
  csrf: string;
  /** Epoch ms. */
  exp: number;
}

const SessionRecord = z.object({ userId: z.string().min(1).max(300), csrf: z.string().min(1), exp: z.number().int() });

/** A 32-byte random token, base64url without padding (43 characters). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes as base64url. */
export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isRandomToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality: the comparison time does not depend on where the inputs differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** KV key of a session: only a hash of the cookie value is stored, so the KV contents are not usable sessions. */
async function sessionKey(id: string): Promise<string> {
  return `${SESSION_KEY_PREFIX}${await sha256Hex(id)}`;
}

/**
 * Starts a session for `userId` with a fresh random id (never reusing one the browser presented, so a
 * planted cookie cannot be fixated) and sets the `__Host-` cookie on the response.
 */
export async function createSession(c: AppContext, userId: string, now = Date.now()): Promise<Session> {
  const id = randomToken();
  const session: Session = { userId, csrf: randomToken(), exp: now + SESSION_TTL_SECONDS * 1000 };
  await c.env.CACHE_KV.put(await sessionKey(id), JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  setCookie(c, SESSION_COOKIE, id, {
    prefix: "host",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return session;
}

/**
 * The signed-in session, or null when the cookie is absent, malformed, unknown or expired, or when no access rule
 * allows its user any more (rechecked through the per-isolate cache, so within a minute of a removal; a failed
 * lookup counts as not allowed). Every page and form gate reads the session here, so a removed user's session ends
 * with their rule.
 */
export async function getSession(c: AppContext, now = Date.now()): Promise<Session | null> {
  const id = getCookie(c, SESSION_COOKIE, "host");
  if (!isRandomToken(id)) return null;
  const raw = await c.env.CACHE_KV.get(await sessionKey(id));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = SessionRecord.safeParse(parsed);
  if (!r.success || r.data.exp <= now) return null;
  if ((await userRoleOrNull(c.env, r.data.userId, now)) === null) return null;
  return r.data;
}

/** Ends the browser's session (if any) server-side and clears the cookie. */
export async function destroySession(c: AppContext): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE, "host");
  if (isRandomToken(id)) await c.env.CACHE_KV.delete(await sessionKey(id));
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", httpOnly: true, sameSite: "Lax" });
}

/** True when a posted form field carries this session's CSRF token. */
export function csrfMatches(session: Session, posted: unknown): boolean {
  return typeof posted === "string" && posted.length > 0 && safeEqual(posted, session.csrf);
}

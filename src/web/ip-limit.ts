import type { MiddlewareHandler } from "hono";
import { RATE_WINDOW_MS } from "../core/limits";
import { GwsError } from "../errors";
import { openStore } from "../store/db";

/**
 * Requests per client address per 60 s window on the unauthenticated entry points. Each of them writes KV
 * (sign-in state, consent state, client records), so an unbounded caller could fill storage. Fixed constants:
 * a human flow needs a handful per minute, the E2E harness a few dozen per run.
 */
export const IP_LIMITS = {
  "/login": 20,
  "/authorize": 30,
  "/oauth/register": 10,
} as const satisfies Record<string, number>;

export type LimitedPath = keyof typeof IP_LIMITS;

const KEY_NAMES: Readonly<Record<LimitedPath, string>> = {
  "/login": "login",
  "/authorize": "authorize",
  "/oauth/register": "register",
};

/** The OAuth provider serves client registration itself, matching exactly this raw path before any router runs. */
const REGISTER_PATH = "/oauth/register";

/** Rows older than the previous window are never read again; one opportunistic delete removes at most this many. */
const PRUNE_BATCH = 100;

/** HKDF info that separates the address-keying key from every other use of TOKEN_ENC_KEY. */
const ADDRESS_KEY_INFO = "gws-mcp ip-limit address key v1";

const utf8 = (s: string) => new TextEncoder().encode(s);

function ipv4Octets(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** The 8 hextets of an IPv6 address (`::` compression, an embedded IPv4 tail and a zone id accepted), or null. */
function ipv6Hextets(text: string): number[] | null {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4Octets(tail);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(missing).fill("0"), ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

/**
 * The identity one counter belongs to: an IPv4 client by its full address, an IPv6 client by its /64 prefix
 * (one subscriber normally holds a whole /64, so the full address costs it nothing to rotate), and an
 * IPv4-mapped IPv6 address by its IPv4 address. Any other text is counted as given.
 */
function addressIdentity(ip: string): string {
  const v4 = ipv4Octets(ip);
  if (v4) return `v4:${v4.join(".")}`;
  const h = ipv6Hextets(ip);
  if (!h) return `raw:${ip.toLowerCase()}`;
  const [h0, h1, h2, h3, h4, h5, h6 = 0, h7 = 0] = h;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return `v4:${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
  }
  return `v6:${h.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** An HMAC key derived (HKDF-SHA-256) from TOKEN_ENC_KEY, so a stored counter key cannot be reversed by enumerating addresses. */
async function addressKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new GwsError("GWS_INTERNAL", "TOKEN_ENC_KEY is not configured");
  const base = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(ADDRESS_KEY_INFO) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** The counter key: route plus a 128-bit HMAC prefix of the client's identity, so D1 never holds an address. */
export async function counterKey(env: Pick<Env, "TOKEN_ENC_KEY">, route: LimitedPath, ip: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await addressKey(env.TOKEN_ENC_KEY), utf8(addressIdentity(ip.trim()))));
  const hex = Array.from(mac.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `ip:${KEY_NAMES[route]}:${hex}`;
}

function refusal(route: LimitedPath, limit: number, windowStart: number, now: number): Response {
  const retryAfterS = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
  return Response.json(
    {
      error: "rate_limited",
      code: "GWS_RATE_LIMITED",
      message: "too many requests from this address; retry after the indicated delay",
      details: { scope: "ip", route, limit, retryAfterS },
    },
    { status: 429, headers: { "retry-after": String(retryAfterS), "cache-control": "no-store" } },
  );
}

/**
 * Counts the request against `route` in a fixed 60 s D1 window. Returns a structured 429 once the address
 * passes the route's limit, else null. The response names the route and limit only, never the address.
 *
 * The window's count is read first: once it is spent, refusals answer without writing, so a flood costs D1
 * reads only. The first request of an address in a window also prunes counter rows of past windows.
 *
 * The address is CF-Connecting-IP, which Cloudflare's edge sets (overwriting any client value) on every request
 * from the internet. On the Node host, its HTTP front sets it the same way (src/runtime/node/http.ts): from the
 * socket's peer, or from a configured trusted proxy's forwarding header, and never from the client. A request
 * without it never came through either: an in-process test or a subrequest over a service binding (no Worker
 * binds this one). Those are not counted.
 */
export async function limitAddress(
  env: Pick<Env, "DB" | "TOKEN_ENC_KEY">,
  route: LimitedPath,
  request: Request,
  now: number = Date.now(),
): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip) return null;
  const windowStart = now - (now % RATE_WINDOW_MS);
  const key = await counterKey(env, route, ip);
  const { rate } = openStore(env);
  const limit = IP_LIMITS[route];
  if ((await rate.count(key, windowStart)) >= limit) return refusal(route, limit, windowStart, now);
  const count = await rate.hit(key, windowStart);
  if (count === 1) await rate.prune(windowStart - RATE_WINDOW_MS, PRUNE_BATCH);
  return count > limit ? refusal(route, limit, windowStart, now) : null;
}

/**
 * The entry-point limit, for client registration only. The provider serves it before any router and matches
 * the raw path exactly (an encoded spelling reaches the web app, which has no such route), so the same exact
 * match here covers every request it serves. /login and /authorize are limited by `ipLimit` on the routes.
 */
export function checkIpLimit(
  env: Pick<Env, "DB" | "TOKEN_ENC_KEY">,
  request: Request,
  now: number = Date.now(),
): Promise<Response | null> {
  return new URL(request.url).pathname === REGISTER_PATH ? limitAddress(env, REGISTER_PATH, request, now) : Promise.resolve(null);
}

/**
 * Router middleware for a web route's limit. Mounted on the route's own path, it sees the path exactly as the
 * router matched it (percent-decoded), so every spelling that reaches the handler is counted.
 */
export function ipLimit(route: Exclude<LimitedPath, typeof REGISTER_PATH>): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const refused = await limitAddress(c.env, route, c.req.raw);
    if (refused) return refused;
    await next();
  };
}

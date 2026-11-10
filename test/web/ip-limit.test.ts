import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_WINDOW_MS } from "../../src/core/limits";
import { IP_LIMITS, checkIpLimit, counterKey, limitAddress } from "../../src/web/ip-limit";

const worker = exports.default;
let ipSeq = 0;
/** A distinct documentation-range address per test, so tests never share a counter. */
const nextIp = () => `198.51.100.${++ipSeq}`;

function req(path: string, ip: string | undefined, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (ip !== undefined) headers["cf-connecting-ip"] = ip;
  return new Request(`http://localhost${path}`, { method, headers, redirect: "manual" });
}

/** Sends `n` requests through the Worker and returns their statuses. */
async function hit(path: string, ip: string, n: number, method = "GET"): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await worker.fetch(req(path, ip, method));
    statuses.push(res.status);
    await res.body?.cancel();
  }
  return statuses;
}

/** The start of the current real window: tests write realistic windows, since a first hit prunes older ones. */
const currentWindow = () => Date.now() - (Date.now() % RATE_WINDOW_MS);

async function storedCount(key: string, windowStart: number): Promise<number | null> {
  const r = await env.DB.prepare("SELECT count FROM rate_counters WHERE key = ? AND window_start = ?").bind(key, windowStart).first<{ count: number }>();
  return r?.count ?? null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("per-IP rate limit on the unauthenticated entry points", () => {
  // The limiter counts per wall-clock minute. A burst of `limit + 1` real requests that crosses a minute boundary
  // starts a fresh count and never sees its 429, which a slow, loaded run makes likely. So the clock (which the
  // Worker code shares with the tests in this isolate) is held 1 s into one window for each test.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - (Date.now() % RATE_WINDOW_MS) + 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits /login, /authorize and /oauth/register with bounded per-minute thresholds", () => {
    expect(Object.keys(IP_LIMITS).sort()).toEqual(["/authorize", "/login", "/oauth/register"]);
    for (const limit of Object.values(IP_LIMITS)) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(60);
    }
  });

  it("answers a structured 429 on /login once an address passes the threshold", async () => {
    const ip = nextIp();
    const limit = IP_LIMITS["/login"];
    const statuses = await hit("/login", ip, limit);
    expect(statuses.every((s) => s !== 429)).toBe(true);

    const res = await worker.fetch(req("/login", ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const retryAfter = Number(res.headers.get("retry-after"));
    // 1 s into the window: the Worker reads the same pinned clock.
    expect(retryAfter).toBe(59);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "rate_limited",
      code: "GWS_RATE_LIMITED",
      message: expect.any(String),
      details: { scope: "ip", route: "/login", limit, retryAfterS: retryAfter },
    });
    expect(JSON.stringify(body)).not.toContain(ip);
  });

  it("counts each route and each address separately", async () => {
    const ip = nextIp();
    await hit("/login", ip, IP_LIMITS["/login"] + 1);
    expect((await hit("/login", ip, 1))[0]).toBe(429);
    // Same address, other route: its own counter.
    expect((await hit("/authorize", ip, 1))[0]).not.toBe(429);
    // Other address, same route: its own counter.
    expect((await hit("/login", nextIp(), 1))[0]).not.toBe(429);
  });

  it("limits /authorize (any method) and client registration", async () => {
    const ip = nextIp();
    const authorize = await hit("/authorize", ip, IP_LIMITS["/authorize"] + 1, "POST");
    expect(authorize.slice(0, -1).every((s) => s !== 429)).toBe(true);
    expect(authorize.at(-1)).toBe(429);

    const ip2 = nextIp();
    const register = await hit("/oauth/register", ip2, IP_LIMITS["/oauth/register"] + 1, "POST");
    expect(register.slice(0, -1).every((s) => s !== 429)).toBe(true);
    expect(register.at(-1)).toBe(429);
  });

  it("limits percent-encoded spellings of /login and /authorize on the same counter as the plain path", async () => {
    const ip = nextIp();
    await hit("/login", ip, IP_LIMITS["/login"]);
    expect(await hit("/%6Cogin", ip, 1)).toEqual([429]);
    expect(await hit("/l%6Fgin", ip, 1)).toEqual([429]);
    expect(await hit("/login", ip, 1)).toEqual([429]);

    // The other direction: an encoded spelling spends the plain path's budget.
    const ip2 = nextIp();
    const encoded = await hit("/%6Cogin", ip2, IP_LIMITS["/login"]);
    expect(encoded.every((s) => s !== 429)).toBe(true);
    expect(await hit("/login", ip2, 1)).toEqual([429]);

    const ip3 = nextIp();
    const authorize = await hit("/%61uthorize", ip3, IP_LIMITS["/authorize"] + 1);
    expect(authorize.slice(0, -1).every((s) => s !== 429)).toBe(true);
    expect(authorize.at(-1)).toBe(429);
  });

  it("serves client registration only at its exact path, so an encoded spelling reaches nothing", async () => {
    const ip = nextIp();
    const res = await worker.fetch(req("/oauth/%72egister", ip, "POST"));
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("never limits other routes", async () => {
    const ip = nextIp();
    await hit("/login", ip, IP_LIMITS["/login"] + 1);
    for (const path of ["/version", "/connections", "/google/callback", "/oauth/token", "/mcp"]) {
      const res = await worker.fetch(req(path, ip, path === "/oauth/token" || path === "/mcp" ? "POST" : "GET"));
      expect(res.status, path).not.toBe(429);
      await res.body?.cancel();
    }
  });

  it("opens a fresh window after a minute", async () => {
    const ip = nextIp();
    const t0 = currentWindow();
    for (let i = 0; i < IP_LIMITS["/login"]; i++) expect(await limitAddress(env, "/login", req("/login", ip), t0 + i)).toBeNull();
    const limited = await limitAddress(env, "/login", req("/login", ip), t0 + 59_000);
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("1");
    expect(await limitAddress(env, "/login", req("/login", ip), t0 + 60_000)).toBeNull();
  });

  it("writes nothing for a refused request", async () => {
    const ip = nextIp();
    const t0 = currentWindow();
    const limit = IP_LIMITS["/login"];
    for (let i = 0; i < limit; i++) expect(await limitAddress(env, "/login", req("/login", ip), t0)).toBeNull();
    const key = await counterKey(env, "/login", ip);
    expect(await storedCount(key, t0)).toBe(limit);
    for (let i = 0; i < 5; i++) expect((await limitAddress(env, "/login", req("/login", ip), t0))?.status).toBe(429);
    expect(await storedCount(key, t0)).toBe(limit);
  });

  it("prunes counter rows of past windows when an address opens a new window", async () => {
    const t0 = currentWindow();
    const old = `ip:login:old-${crypto.randomUUID()}`;
    const previous = `ip:login:prev-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 3)").bind(old, t0 - 3 * RATE_WINDOW_MS),
      env.DB.prepare("INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 3)").bind(previous, t0 - RATE_WINDOW_MS),
    ]);
    expect(await limitAddress(env, "/login", req("/login", nextIp()), t0)).toBeNull();
    expect(await storedCount(old, t0 - 3 * RATE_WINDOW_MS)).toBeNull();
    // The previous window stays: only rows older than it are past use.
    expect(await storedCount(previous, t0 - RATE_WINDOW_MS)).toBe(3);
  });

  it("keys an IPv6 client on its /64 prefix and an IPv4 client on its full address", async () => {
    const t0 = currentWindow();
    const limit = IP_LIMITS["/login"];
    for (let i = 0; i < limit; i++) {
      // Every request from another address inside one /64.
      expect(await limitAddress(env, "/login", req("/login", `2001:db8:aa:1::${(i + 1).toString(16)}`), t0)).toBeNull();
    }
    expect((await limitAddress(env, "/login", req("/login", "2001:0db8:00aa:0001:ffff:ffff:ffff:ffff"), t0))?.status).toBe(429);
    expect(await limitAddress(env, "/login", req("/login", "2001:db8:aa:2::1"), t0)).toBeNull();

    expect(await counterKey(env, "/login", "2001:db8:aa:1::1")).toBe(await counterKey(env, "/login", "2001:db8:aa:1:1:2:3:4"));
    expect(await counterKey(env, "/login", "2001:db8:aa:1::1")).not.toBe(await counterKey(env, "/login", "2001:db8:aa:2::1"));
    expect(await counterKey(env, "/login", "203.0.113.1")).not.toBe(await counterKey(env, "/login", "203.0.113.2"));
    // An IPv4-mapped IPv6 address is that IPv4 client, not a /64 shared by every IPv4 client.
    expect(await counterKey(env, "/login", "::ffff:203.0.113.1")).toBe(await counterKey(env, "/login", "203.0.113.1"));
    expect(await counterKey(env, "/login", "::ffff:203.0.113.1")).not.toBe(await counterKey(env, "/login", "::ffff:203.0.113.2"));
  });

  it("keys counters with a secret-keyed HMAC, never a bare hash or the raw address", async () => {
    const ip = nextIp();
    const t0 = currentWindow();
    expect(await limitAddress(env, "/login", req("/login", ip), t0)).toBeNull();
    const key = await counterKey(env, "/login", ip);
    expect(key).toMatch(/^ip:login:[0-9a-f]{32}$/);
    expect(key).not.toContain(ip);
    const hex = key.slice("ip:login:".length);
    expect((await sha256Hex(ip)).startsWith(hex)).toBe(false);
    expect((await sha256Hex(`v4:${ip}`)).startsWith(hex)).toBe(false);
    // Stable within a run: the stored row is the one this key names.
    expect(await counterKey(env, "/login", ip)).toBe(key);
    expect(await storedCount(key, t0)).toBe(1);
    // It depends on the secret.
    expect(await counterKey({ ...env, TOKEN_ENC_KEY: btoa("another-test-only-key-0123456789") }, "/login", ip)).not.toBe(key);
  });

  it("does not count requests that did not come through the edge (no client address)", async () => {
    const t0 = currentWindow();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_counters").first<{ n: number }>();
    for (let i = 0; i <= IP_LIMITS["/oauth/register"]; i++) {
      expect(await checkIpLimit(env, req("/oauth/register", undefined, "POST"), t0)).toBeNull();
    }
    expect(await checkIpLimit(env, req("/oauth/register", "  ", "POST"), t0)).toBeNull();
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_counters").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("limits only client registration at the entry; the web routes limit themselves as routed", async () => {
    const ip = nextIp();
    const t0 = currentWindow();
    for (let i = 0; i <= IP_LIMITS["/login"]; i++) expect(await checkIpLimit(env, req("/login", ip), t0)).toBeNull();
  });
});

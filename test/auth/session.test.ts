import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  createSession,
  csrfMatches,
  destroySession,
  getSession,
  sha256Hex,
  type Session,
} from "../../src/auth/session";

const LATER = 13 * 60 * 60 * 1000;

const app = new Hono<{ Bindings: Env }>();
app.post("/create", async (c) => c.json(await createSession(c, "u_session-test")));
app.get("/get", async (c) => c.json(await getSession(c)));
app.get("/get-later", async (c) => c.json(await getSession(c, Date.now() + LATER)));
app.post("/destroy", async (c) => {
  await destroySession(c);
  return c.body(null, 204);
});

function call(path: string, cookie?: string): Promise<Response> {
  return Promise.resolve(app.request(path, { method: path === "/create" || path === "/destroy" ? "POST" : "GET", headers: cookie ? { cookie } : {} }, env));
}

async function created(): Promise<{ id: string; setCookie: string; session: Session }> {
  const res = await call("/create");
  const setCookie = res.headers.getSetCookie()[0] ?? "";
  const id = /^__Host-gws_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
  return { id, setCookie, session: (await res.json()) as Session };
}

describe("session cookie", () => {
  it("is a __Host- cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, 12 h", async () => {
    const { id, setCookie } = await created();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const attrs = setCookie.split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["secure", "httponly", "samesite=lax", "path=/", `max-age=${SESSION_TTL_SECONDS}`]));
    expect(attrs.some((a) => a.startsWith("domain"))).toBe(false);
  });

  it("gives every session a new random id and its own CSRF token", async () => {
    const a = await created();
    const b = await created();
    expect(a.id).not.toBe(b.id);
    expect(a.session.csrf).not.toBe(b.session.csrf);
    expect(a.session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("session store", () => {
  it("creates, then reads the session back from the cookie", async () => {
    const { id, session } = await created();
    const got = (await (await call("/get", `__Host-gws_session=${id}`)).json()) as Session | null;
    expect(got).toEqual(session);
    expect(got?.userId).toBe("u_session-test");
    expect(session.exp).toBeGreaterThan(Date.now() + SESSION_TTL_SECONDS * 1000 - 60_000);
  });

  it("keys KV by a hash of the id, never the id itself, with a 12 h TTL", async () => {
    const { id } = await created();
    expect(await env.CACHE_KV.get(`sess:${id}`)).toBeNull();
    const key = `sess:${await sha256Hex(id)}`;
    const stored = await env.CACHE_KV.get(key);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(id);
    const listed = (await env.CACHE_KV.list({ prefix: "sess:" })).keys;
    expect(listed.some((k) => k.name.includes(id))).toBe(false);
    const entry = listed.find((k) => k.name === key);
    expect(entry?.expiration).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS - 60);
  });

  it("treats an expired session as absent", async () => {
    const { id } = await created();
    expect(await (await call("/get-later", `__Host-gws_session=${id}`)).json()).toBeNull();
  });

  it("ignores an unknown id, a malformed one and a cookie without the __Host- prefix", async () => {
    const { id } = await created();
    for (const cookie of [`__Host-gws_session=${"A".repeat(43)}`, "__Host-gws_session=short", `gws_session=${id}`, undefined]) {
      expect(await (await call("/get", cookie)).json()).toBeNull();
    }
  });

  it("destroys the session server-side and clears the cookie", async () => {
    const { id } = await created();
    const res = await call("/destroy", `__Host-gws_session=${id}`);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/__Host-gws_session=;.*Max-Age=0/i);
    expect(await env.CACHE_KV.get(`sess:${await sha256Hex(id)}`)).toBeNull();
    expect(await (await call("/get", `__Host-gws_session=${id}`)).json()).toBeNull();
  });
});

describe("csrfMatches", () => {
  const session: Session = { userId: "u_1", csrf: "x".repeat(43), exp: Date.now() + 1000 };
  it("accepts only the session's own token", () => {
    expect(csrfMatches(session, "x".repeat(43))).toBe(true);
    for (const posted of ["x".repeat(42), "y".repeat(43), "", undefined, ["x".repeat(43)], `${"x".repeat(43)}x`]) {
      expect(csrfMatches(session, posted)).toBe(false);
    }
  });
});

import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FLASH_TTL_SECONDS, setFlash, takeFlash, type Flash } from "../../src/web/flash";
import { Browser } from "../auth/browser";

const SECRET_NAME = "Private <b>Work</b> app";

/** A tiny app around the flash API: set as one user and redirect, then read as a given user. */
function flashApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/set/:user", async (c) => {
    const body = (await c.req.json()) as Flash;
    await setFlash(c, c.req.param("user"), body);
    return c.redirect("/next", 303);
  });
  app.get("/take/:user", async (c) => c.json({ flash: await takeFlash(c, c.req.param("user")) }));
  return new Browser(async (r) => app.fetch(r, env));
}

async function set(browser: Browser, user: string, flash: Flash): Promise<Response> {
  return browser.fetch(`/set/${user}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(flash) });
}

async function take(browser: Browser, user: string): Promise<{ flash: Flash | null; setCookie: string[] }> {
  const res = await browser.fetch(`/take/${user}`);
  return { ...((await res.json()) as { flash: Flash | null }), setCookie: res.headers.getSetCookie() };
}

const removed: Flash = { tone: "success", kind: "app-removed", appName: SECRET_NAME };

describe("flash", () => {
  it("carries the message in an opaque, short-lived, HttpOnly __Host- cookie with nothing in the URL", async () => {
    const browser = flashApp();
    const res = await set(browser, "u_1", removed);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/next");
    const [cookie, ...others] = res.headers.getSetCookie();
    expect(others).toEqual([]);
    expect(cookie).toMatch(/^__Host-gws_flash=[A-Za-z0-9_-]{43};/);
    const attrs = (cookie ?? "").split(";").slice(1).map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining([`max-age=${FLASH_TTL_SECONDS}`, "path=/", "secure", "httponly", "samesite=lax"]));
    expect(attrs.some((a) => a.startsWith("domain"))).toBe(false);
    expect(cookie).not.toContain("Work");
    expect(FLASH_TTL_SECONDS).toBeLessThanOrEqual(120);
  });

  it("shows once to the user it was set for, then is gone and its cookie cleared", async () => {
    const browser = flashApp();
    await set(browser, "u_1", removed);
    const first = await take(browser, "u_1");
    expect(first.flash).toEqual(removed);
    expect(first.setCookie.join(";")).toMatch(/__Host-gws_flash=;.*max-age=0/i);
    expect((await take(browser, "u_1")).flash).toBeNull();
  });

  it("stores only a hash of the cookie value as the key, so the stored records are not usable references", async () => {
    const browser = flashApp();
    await set(browser, "u_1", removed);
    const ref = browser.cookies.get("__Host-gws_flash") ?? "";
    const { keys } = await env.CACHE_KV.list({ prefix: "flash:" });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.name.includes(ref))).toBe(false);
  });

  it("is discarded, not shown, for another signed-in user", async () => {
    const browser = flashApp();
    await set(browser, "u_1", removed);
    expect((await take(browser, "u_2")).flash).toBeNull();
    expect((await take(browser, "u_1")).flash).toBeNull();
  });

  it("ignores a missing, malformed or unknown reference", async () => {
    const browser = flashApp();
    expect((await take(browser, "u_1")).flash).toBeNull();
    browser.cookies.set("__Host-gws_flash", "not a token");
    expect((await take(browser, "u_1")).flash).toBeNull();
    browser.cookies.set("__Host-gws_flash", "a".repeat(43));
    expect((await take(browser, "u_1")).flash).toBeNull();
  });

  it("ignores a stored record that is not a valid flash", async () => {
    const browser = flashApp();
    await set(browser, "u_1", removed);
    const { keys } = await env.CACHE_KV.list({ prefix: "flash:" });
    for (const k of keys) await env.CACHE_KV.put(k.name, JSON.stringify({ userId: "u_1", flash: { tone: "success", kind: "<script>" } }));
    expect((await take(browser, "u_1")).flash).toBeNull();
  });

  it("refuses to set a flash that is not one of the known kinds and shapes", async () => {
    const browser = flashApp();
    const bad = [
      { tone: "success", kind: "made-up" },
      { tone: "loud", kind: "app-removed" },
      { tone: "success", kind: "account-connected", accountId: "x".repeat(300) },
      { tone: "success", kind: "account-connected", extra: "field" },
    ];
    for (const flash of bad) {
      const res = await set(browser, "u_1", flash as Flash).catch((e: unknown) => e);
      expect(res instanceof Response ? res.status : 500).toBe(500);
    }
    expect(browser.cookies.has("__Host-gws_flash")).toBe(false);
  });
});

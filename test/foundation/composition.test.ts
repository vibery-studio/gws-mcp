import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { registry } from "../../src/sdk/index";

const worker = exports.default;

describe("worker composition", () => {
  it("rejects an unauthenticated MCP call with 401 and a bearer challenge", async () => {
    const res = await worker.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/i);
  });

  it("rejects a forged bearer token", async () => {
    const res = await worker.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  // Later phases replace these stubs, so assert only the wiring: each route is mounted (never the 404
  // fallback), and while it is still a stub it answers the static 501 body and nothing else.
  it.each([
    ["GET", "/authorize"],
    ["GET", "/login"],
    ["GET", "/google/callback"],
    ["GET", "/connections"],
    ["GET", "/connect/start"],
    ["GET", "/version"],
  ])("%s %s is mounted", async (method, path) => {
    const res = await worker.fetch(`http://localhost${path}`, { method, redirect: "manual" });
    expect(res.status).not.toBe(404);
    if (res.status === 501) expect(await res.json()).toEqual({ error: "not_implemented" });
  });

  it("answers 404 for unknown paths", async () => {
    const res = await worker.fetch("http://localhost/nope");
    expect(res.status).toBe(404);
  });

  it("assembles the registry as a list of fn definitions", () => {
    const fns = registry();
    expect(Array.isArray(fns)).toBe(true);
    for (const fn of fns) expect(typeof fn.name).toBe("string");
  });
});

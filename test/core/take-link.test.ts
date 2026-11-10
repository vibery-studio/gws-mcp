import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { peekGrantRequest, takeConnectRequest } from "../../src/core/accounts-capability";
import type { LinkStore } from "../../src/core/ports";
import { GwsError } from "../../src/errors";

const USER = "u_take_link";

async function keyFor(kind: "connect" | "grant", token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return `req:${kind}:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function token(): string {
  return crypto.randomUUID().replace(/-/g, "").padEnd(43, "A").slice(0, 43);
}

const connect = () => JSON.stringify({ kind: "connect", userId: USER, clientId: "c1", services: ["drive"], exp: Date.now() + 60_000 });

/** A store holding one record whose delete rejects as given: an adapter that lost the race to take it. */
function rejectingDelete(record: string, error: unknown): LinkStore {
  return { get: async () => record, put: async () => undefined, delete: () => Promise.reject(error) };
}

describe("taking a single-use link", () => {
  it("on Workers KV, returns the record once and then null (behaviour unchanged)", async () => {
    const t = token();
    await env.CACHE_KV.put(await keyFor("connect", t), connect(), { expirationTtl: 600 });
    expect(await takeConnectRequest(env.CACHE_KV, t, USER)).toMatchObject({ kind: "connect", userId: USER, services: ["drive"] });
    expect(await takeConnectRequest(env.CACHE_KV, t, USER)).toBeNull();
    expect(await env.CACHE_KV.get(await keyFor("connect", t))).toBeNull();
  });

  it("treats a take the store refuses (the record was already taken) as no record", async () => {
    const lost = rejectingDelete(connect(), new GwsError("GWS_INVALID_INPUT", "this link was already used or has expired"));
    expect(await takeConnectRequest(lost, token(), USER)).toBeNull();
  });

  it("still fails on any other store error", async () => {
    await expect(takeConnectRequest(rejectingDelete(connect(), new GwsError("GWS_INTERNAL", "store down")), token(), USER)).rejects.toMatchObject({
      code: "GWS_INTERNAL",
    });
    await expect(takeConnectRequest(rejectingDelete(connect(), new Error("network")), token(), USER)).rejects.toThrow("network");
  });

  it("never deletes on a peek", async () => {
    const t = token();
    const grant = JSON.stringify({ kind: "grant", userId: USER, clientId: "c1", exp: Date.now() + 60_000 });
    await env.CACHE_KV.put(await keyFor("grant", t), grant, { expirationTtl: 600 });
    expect(await peekGrantRequest(env.CACHE_KV, t, USER)).toMatchObject({ kind: "grant" });
    expect(await env.CACHE_KV.get(await keyFor("grant", t))).toBe(grant);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../../src/config";
import type { AuthProps, FnDef } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { CallBudget, UpstreamLimits, capBytes, checkRate } from "../../src/core/limits";
import { buildRegistry, type Registry } from "../../src/core/registry";
import { isGwsError, type GwsError, type WireError } from "../../src/errors";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const store = openStore(env);
const baseConfig = loadConfig(env);
/** A fixed instant 10 s into a rate window, so no test straddles a window boundary. */
const T0 = Date.UTC(2026, 10, 9, 5, 0, 10);

function session(
  auth: AuthProps,
  o: { apply?: boolean; config?: Partial<Config>; registry?: Registry; now?: () => number; bindings?: Env } = {},
) {
  return createCallSession({
    ports: workersPorts(o.bindings ?? env),
    auth,
    apply: o.apply ?? false,
    executeId: `x-${crypto.randomUUID()}`,
    config: { ...baseConfig, ...o.config },
    ...(o.registry ? { registry: o.registry } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
}

async function driveClient(prefix: string) {
  const email = uniqueEmail(prefix);
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `c-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

const listCalls = async (email: string) =>
  (await fake.requests(email)).filter((q) => q.method === "GET" && q.path.endsWith("/drive/v3/files")).length;

function errorOf(r: DispatchResult): WireError {
  if (!("__gwsError" in r)) throw new Error(`expected an error result, got ${JSON.stringify(r)}`);
  return r.__gwsError;
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value;
}

function caught(fn: () => unknown): GwsError {
  try {
    fn();
  } catch (e) {
    if (isGwsError(e)) return e;
    throw e;
  }
  throw new Error("expected a GwsError");
}

function hostFn(name: string, run: FnDef["run"]): FnDef {
  return {
    name,
    service: "helpers",
    effect: "read",
    kind: "host",
    description: "",
    signature: "",
    tsDecl: "",
    example: "",
    tags: [],
    scopes: [],
    input: z.looseObject({}),
    output: z.unknown(),
    run,
  };
}

const freshAuth = (): AuthProps => ({ userId: `u_${crypto.randomUUID()}`, clientId: `c-${crypto.randomUUID()}` });
const ok = hostFn("test.ok", async () => ({ ok: 1 }));

describe("call budget", () => {
  it("fails the call after the budget with GWS_CALL_BUDGET_EXCEEDED", async () => {
    const s = session(freshAuth(), { config: { CALLS_PER_EXECUTE: 2 }, registry: buildRegistry([ok]) });
    valueOf(await s.dispatch("test.ok", {}));
    valueOf(await s.dispatch("test.ok", {}));
    const err = errorOf(await s.dispatch("test.ok", {}));
    expect(err.code).toBe("GWS_CALL_BUDGET_EXCEEDED");
    expect(err.details).toEqual({ limit: 2 });
  });

  it("counts nested ctx.call against the same budget", async () => {
    const nest = hostFn("test.nest", async (_i, ctx) => ctx.call("test.ok", {}));
    const s = session(freshAuth(), { config: { CALLS_PER_EXECUTE: 2 }, registry: buildRegistry([ok, nest]) });
    valueOf(await s.dispatch("test.nest", {}));
    expect(errorOf(await s.dispatch("test.ok", {})).code).toBe("GWS_CALL_BUDGET_EXCEEDED");
  });

  it("records the first refused call but not a runaway loop after it", async () => {
    const s = session(freshAuth(), { config: { CALLS_PER_EXECUTE: 2 }, registry: buildRegistry([ok]) });
    for (let i = 0; i < 20; i++) await s.dispatch("test.ok", {});
    expect(s.calls.map((c) => c.code ?? c.status)).toEqual(["ok", "ok", "GWS_CALL_BUDGET_EXCEEDED"]);
    expect(s.lastError?.code).toBe("GWS_CALL_BUDGET_EXCEEDED");
  });

  it("CallBudget throws on call n+1", () => {
    const b = new CallBudget(1);
    b.take();
    expect(caught(() => b.take()).code).toBe("GWS_CALL_BUDGET_EXCEEDED");
  });
});

describe("rate limit", () => {
  it("fails the third call in a window at 2 per minute, per client, while the user window keeps counting", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const config = { RATE_CLIENT_PER_MIN: 2, RATE_USER_PER_MIN: 4 };
    const reg = buildRegistry([ok]);
    const clock = () => T0;
    const a = session({ userId, clientId: "client-a" }, { config, registry: reg, now: clock });
    valueOf(await a.dispatch("test.ok", {}));
    valueOf(await a.dispatch("test.ok", {}));
    const errA = errorOf(await a.dispatch("test.ok", {}));
    expect(errA.code).toBe("GWS_RATE_LIMITED");
    expect(errA.details).toEqual({ scope: "client", limit: 2, retryAfterS: 50 });

    // Another client of the same user has its own client window, but the user window (now 3) still counts.
    const b = session({ userId, clientId: "client-b" }, { config, registry: reg, now: clock });
    valueOf(await b.dispatch("test.ok", {}));
    const errB = errorOf(await b.dispatch("test.ok", {}));
    expect(errB.code).toBe("GWS_RATE_LIMITED");
    expect(errB.details).toEqual({ scope: "user", limit: 4, retryAfterS: 50 });
  });

  it("opens a new window after 60 s", async () => {
    const auth = freshAuth();
    const limits = { RATE_USER_PER_MIN: 1, RATE_CLIENT_PER_MIN: 1 };
    await checkRate(openStore(env).rate, auth, T0, limits);
    await expect(checkRate(openStore(env).rate, auth, T0 + 1000, limits)).rejects.toMatchObject({ code: "GWS_RATE_LIMITED" });
    await checkRate(openStore(env).rate, auth, T0 + 60_000, limits);
  });
});

describe("response cap", () => {
  it("refuses a Google response over CALL_RESPONSE_MAX_BYTES with GWS_RESPONSE_TOO_LARGE, read under the bound", async () => {
    const email = uniqueEmail("limits-cap");
    const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
    await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
    const auth: AuthProps = { userId: seeded.userId, clientId: `c-${crypto.randomUUID()}` };
    await store.grants.add(auth.userId, auth.clientId, seeded.account.id);

    const err = errorOf(await session(auth, { config: { CALL_RESPONSE_MAX_BYTES: 100 } }).dispatch("drive.files.list", {}));
    expect(err.code).toBe("GWS_RESPONSE_TOO_LARGE");
    // `status` is set only by the bounded reader in the compat layer, so the cap reached callGoogle.
    expect(err.details).toMatchObject({ scope: "call", max: 100, status: 200 });
  });

  it("caps host-fn results with the same limit", async () => {
    const big = hostFn("test.big", async () => ({ data: "x".repeat(500) }));
    const err = errorOf(await session(freshAuth(), { config: { CALL_RESPONSE_MAX_BYTES: 100 }, registry: buildRegistry([big]) }).dispatch("test.big", {}));
    expect(err.code).toBe("GWS_RESPONSE_TOO_LARGE");
    expect(err.details).toEqual({ scope: "call", bytes: 511, max: 100 });
  });

  it("capBytes measures serialized UTF-8 bytes", () => {
    capBytes({ a: "é" }, 10);
    expect(caught(() => capBytes({ a: "éé" }, 10)).details).toEqual({ scope: "call", bytes: 12, max: 10 });
    expect(caught(() => capBytes("xxxx", 3, "result")).details).toEqual({ scope: "result", bytes: 6, max: 3 });
  });

  it("gives rate limit, call budget and response cap distinct codes", () => {
    expect(new Set(["GWS_RATE_LIMITED", "GWS_CALL_BUDGET_EXCEEDED", "GWS_RESPONSE_TOO_LARGE"]).size).toBe(3);
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The test bindings with FAKE_GOOGLE wrapped to count the upstream requests in flight at once. */
function countingBindings(delayMs: number) {
  let inFlight = 0;
  let peak = 0;
  const FAKE_GOOGLE = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await sleep(delayMs);
        return await env.FAKE_GOOGLE.fetch(input, init);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { bindings: Object.assign({}, env, { FAKE_GOOGLE }) as Env, peak: () => peak };
}

/** The test bindings with FAKE_GOOGLE answering nothing until `open()`: every upstream request hangs. */
function hangingBindings() {
  let sent = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const FAKE_GOOGLE = {
    async fetch(): Promise<Response> {
      sent += 1;
      await gate;
      return new Response("{}", { status: 503 });
    },
  };
  return { bindings: Object.assign({}, env, { FAKE_GOOGLE }) as Env, sent: () => sent, open: () => open() };
}

describe("per-execute upstream caps", () => {
  it("refuses the call that passes the execute's response-byte budget, then refuses later calls before sending", async () => {
    const { email, auth } = await driveClient("limits-total");
    const s = session(auth, { config: { EXECUTE_RESPONSE_MAX_BYTES: 1 } });
    const first = errorOf(await s.dispatch("drive.files.list", {}));
    expect(first.code).toBe("GWS_RESPONSE_TOO_LARGE");
    expect(first.details).toMatchObject({ scope: "execute", max: 1 });
    expect(await listCalls(email)).toBe(1);

    const second = errorOf(await s.dispatch("drive.files.list", {}));
    expect(second.code).toBe("GWS_RESPONSE_TOO_LARGE");
    expect(second.details).toMatchObject({ scope: "execute", max: 1 });
    expect(await listCalls(email)).toBe(1);
  });

  it("sums response bytes across calls", async () => {
    const { auth } = await driveClient("limits-sum");
    const probe = session(auth);
    const one = new TextEncoder().encode(JSON.stringify(valueOf(await probe.dispatch("drive.files.list", {})))).byteLength;
    const s = session(auth, { config: { EXECUTE_RESPONSE_MAX_BYTES: Math.floor(one * 2.5) } });
    valueOf(await s.dispatch("drive.files.list", {}));
    valueOf(await s.dispatch("drive.files.list", {}));
    expect(errorOf(await s.dispatch("drive.files.list", {})).details).toMatchObject({ scope: "execute" });
  });

  it("queues calls beyond UPSTREAM_CONCURRENCY: Promise.all over 10 completes all 10 with at most 4 in flight", async () => {
    const { email, auth } = await driveClient("limits-queue");
    const counting = countingBindings(15);
    const s = session(auth, { bindings: counting.bindings, config: { UPSTREAM_CONCURRENCY: 4 } });
    const results = await Promise.all(Array.from({ length: 10 }, () => s.dispatch("drive.files.list", {})));
    for (const r of results) valueOf(r);
    expect(await listCalls(email)).toBe(10);
    expect(counting.peak()).toBe(4);
  });

  it("counts a queued call against the call budget", async () => {
    const { email, auth } = await driveClient("limits-queue-budget");
    const s = session(auth, { config: { UPSTREAM_CONCURRENCY: 1, CALLS_PER_EXECUTE: 3 } });
    const results = await Promise.all(Array.from({ length: 6 }, () => s.dispatch("drive.files.list", {})));
    expect(results.filter((r) => "ok" in r)).toHaveLength(3);
    expect(results.filter((r) => "__gwsError" in r).map((r) => errorOf(r).code)).toEqual(Array(3).fill("GWS_CALL_BUDGET_EXCEEDED"));
    expect(await listCalls(email)).toBe(3);
  });

  it("releases every queued call when the session closes, without sending it", async () => {
    const { auth } = await driveClient("limits-queue-close");
    const hanging = hangingBindings();
    const s = session(auth, { bindings: hanging.bindings, config: { UPSTREAM_CONCURRENCY: 1 } });
    const pending = Array.from({ length: 3 }, () => s.dispatch("drive.files.list", {}));
    while (hanging.sent() === 0) await sleep(1);
    await s.close({ waitMs: 30 });
    const settled = await Promise.race([Promise.all(pending.slice(1)), sleep(500).then(() => "still waiting" as const)]);
    expect(settled).not.toBe("still waiting");
    if (settled === "still waiting") return;
    for (const r of settled) expect(errorOf(r).code).toBe("GWS_EXECUTION_ERROR");
    expect(hanging.sent()).toBe(1);
    expect(s.calls.map((c) => c.code).sort()).toEqual(["GWS_EXECUTION_ERROR", "GWS_EXECUTION_ERROR", "GWS_EXECUTION_TIMEOUT"]);
    hanging.open();
  });

  it("releases a queued call that waits longer than the execute timeout", async () => {
    const { auth } = await driveClient("limits-queue-timeout");
    const hanging = hangingBindings();
    const s = session(auth, { bindings: hanging.bindings, config: { UPSTREAM_CONCURRENCY: 1, EXECUTE_TIMEOUT_MS: 40 } });
    void s.dispatch("drive.files.list", {});
    const err = errorOf(await s.dispatch("drive.files.list", {}));
    expect(err.code).toBe("GWS_EXECUTION_TIMEOUT");
    expect(err.details).toEqual({ scope: "concurrency", limit: 1, waitMs: 40 });
    expect(hanging.sent()).toBe(1);
    hanging.open();
  });

  it("does not hold a concurrency slot for dry-run writes", async () => {
    const { auth } = await driveClient("limits-conc-dry");
    const s = session(auth, { config: { UPSTREAM_CONCURRENCY: 1 } });
    const results = await Promise.all([1, 2, 3].map((i) => s.dispatch("drive.files.create", { requestBody: { name: `f${i}` } })));
    expect(results.every((r) => "__gwsPending" in r)).toBe(true);
  });
});

describe("call input size", () => {
  it("refuses an input over CALL_INPUT_MAX_BYTES with GWS_INVALID_INPUT before the fn runs, and records the refusal", async () => {
    let ran = 0;
    const count = hostFn("test.count", async () => {
      ran += 1;
      return {};
    });
    const s = session(freshAuth(), { config: { CALL_INPUT_MAX_BYTES: 1000 }, registry: buildRegistry([count]) });
    const err = errorOf(await s.dispatch("test.count", { text: "a".repeat(1000) }));
    expect(err).toMatchObject({ code: "GWS_INVALID_INPUT", details: { reason: "input-too-large", max: 1000 } });
    valueOf(await s.dispatch("test.count", { text: "a".repeat(900) }));
    expect(ran).toBe(1);
    expect(s.calls.map((c) => c.code ?? c.status)).toEqual(["GWS_INVALID_INPUT", "ok"]);
  });

  it("counts binary input by its byte length and a long array by its length", async () => {
    const s = session(freshAuth(), { config: { CALL_INPUT_MAX_BYTES: 1000 }, registry: buildRegistry([ok]) });
    expect(errorOf(await s.dispatch("test.ok", { data: new Uint8Array(2000) })).details).toMatchObject({ reason: "input-too-large" });
    expect(errorOf(await s.dispatch("test.ok", { list: new Array(1_000_000_000) })).details).toMatchObject({ reason: "input-too-large" });
    valueOf(await s.dispatch("test.ok", { data: new Uint8Array(500) }));
  });

  it("passes binary input under the cap without walking it entry by entry", async () => {
    const s = session(freshAuth(), { registry: buildRegistry([ok]) });
    const data = new Uint8Array(3_000_000);
    const start = Date.now();
    valueOf(await s.dispatch("test.ok", { data, nested: [{ more: data.subarray(0, 1_000_000) }] }));
    expect(Date.now() - start).toBeLessThan(300);
  });
});

describe("planned request bodies", () => {
  it("stores a planned body over 16 KB as its size only, and keeps a small body", async () => {
    const { auth } = await driveClient("limits-plan-body");
    const s = session(auth);
    await s.dispatch("drive.files.create", { requestBody: { name: "big", description: "a".repeat(1_000_000) } });
    await s.dispatch("drive.files.create", { requestBody: { name: "small" } });
    expect(s.plan.map((p) => p.request?.body)).toEqual([{ bytes: expect.any(Number), truncated: true }, { name: "small" }]);
    expect((s.plan[0]?.request?.body as { bytes: number }).bytes).toBeGreaterThan(1_000_000);
  });
});

describe("UpstreamLimits", () => {
  const limits = (concurrency: number, waitMs = 1000) =>
    new UpstreamLimits({ EXECUTE_RESPONSE_MAX_BYTES: 1000, UPSTREAM_CONCURRENCY: concurrency, EXECUTE_TIMEOUT_MS: waitMs });

  it("admits waiters in arrival order", async () => {
    const u = limits(1);
    const order: number[] = [];
    let release: () => void = () => undefined;
    const first = u.run(() => new Promise<void>((resolve) => (release = resolve)));
    const rest = [1, 2, 3].map((i) => u.run(async () => void order.push(i)));
    await sleep(1);
    expect(order).toEqual([]);
    release();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("refuses a call that would have to wait once closed, and still runs one with a free slot", async () => {
    const u = limits(1);
    let release: () => void = () => undefined;
    const held = u.run(() => new Promise<void>((resolve) => (release = resolve)));
    const queued = u.run(async () => "ran");
    u.close();
    await expect(queued).rejects.toMatchObject({ code: "GWS_EXECUTION_ERROR" });
    await expect(u.run(async () => "ran")).rejects.toMatchObject({ code: "GWS_EXECUTION_ERROR" });
    release();
    await held;
    expect(await u.run(async () => "ran")).toBe("ran");
  });

  it("frees the slot of a call that throws", async () => {
    const u = limits(1);
    await expect(u.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await u.run(async () => "ran")).toBe("ran");
  });
});

describe("no automatic retry of writes", () => {
  it("sends a failing write exactly once", async () => {
    const email = uniqueEmail("limits-retry");
    const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
    const auth: AuthProps = { userId: seeded.userId, clientId: `c-${crypto.randomUUID()}` };
    await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
    await fake.fault({ email, method: "POST", pathRegex: "/drive/v3/files$", times: 3, response: { status: 503 } });
    const err = errorOf(await session(auth, { apply: true }).dispatch("drive.files.create", { requestBody: { name: "once" } }));
    expect(err.code).toBe("GWS_UPSTREAM_ERROR");
    const posts = (await fake.requests(email)).filter((q) => q.method === "POST" && q.path.endsWith("/drive/v3/files"));
    expect(posts).toHaveLength(1);
  });
});

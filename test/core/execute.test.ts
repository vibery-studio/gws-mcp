import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../../src/config";
import type { AuthProps, CallCtx, FnDef } from "../../src/contracts";
import { EXECUTE_CPU_MS, HOST_DEADLINE_GRACE_MS, runExecute, runSandbox } from "../../src/core/execute";
import { jsonBytes } from "../../src/core/limits";
import { buildRegistry, type Registry } from "../../src/core/registry";
import { workersPorts } from "../../src/runtime/workers/ports";
import { workersSandbox } from "../../src/runtime/workers/sandbox";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const baseConfig = loadConfig(env);

async function driveAccount() {
  const email = uniqueEmail("execute");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await openStore(env).grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { ...seeded, email, auth };
}

function exec(
  auth: AuthProps,
  code: string,
  o: { apply?: boolean; config?: Partial<Config>; registry?: Registry; bindings?: Env; now?: () => number } = {},
) {
  return runExecute({
    code,
    apply: o.apply ?? false,
    auth,
    ports: workersPorts(o.bindings ?? env),
    config: { ...baseConfig, ...o.config },
    ...(o.registry ? { registry: o.registry } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
}

/** A Worker Loader whose child fails the way the platform ends a child over its CPU limit. */
function cpuExceededLoader(seenLimits: unknown[]): WorkerLoader {
  const worker = { getEntrypoint: () => ({ evaluate: () => Promise.reject(new Error("Worker exceeded CPU time limit.")) }) };
  return {
    load: (code) => {
      seenLimits.push(code.limits);
      return worker as unknown as WorkerStub;
    },
    get: () => {
      throw new Error("the executor loads its child with load()");
    },
  };
}

async function auditRows(executeId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
  return results;
}

async function driveFiles(email: string): Promise<Array<{ id: string; name?: string }>> {
  const { resources } = await fake.state(email);
  return Object.entries(resources)
    .filter(([k]) => k.startsWith(`drive:file:${email}:`))
    .map(([, v]) => v as { id: string; name?: string });
}

async function permissionsOf(email: string, fileId: string): Promise<Array<{ type?: string }>> {
  const { resources } = await fake.state(email);
  return Object.entries(resources)
    .filter(([k]) => k.includes(fileId) && k.includes("perm"))
    .map(([, v]) => v as { type?: string });
}

function hostFn(name: string, run: (input: unknown, ctx: CallCtx) => Promise<unknown>): FnDef {
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

const CREATE_AND_SHARE = `async () => {
  const created = await sdk.drive.files.create({ requestBody: { name: "shared-report.txt" } });
  const perm = await sdk.drive.permissions.create({ fileId: created.id, requestBody: { type: "anyone", role: "reader" } });
  return { id: created.id, perm: perm.id };
}`;

describe("execute", () => {
  it("returns zod-validated data from a read snippet", async () => {
    const { auth } = await driveAccount();
    const out = await exec(auth, "async () => { const r = await sdk.drive.files.list({}); return r.files.map((f) => f.name).sort(); }");
    expect(out).toMatchObject({ ok: true, applied: false, destructive: false, plan: [], unauditedRefusals: 0 });
    expect(out.result).toEqual(expect.arrayContaining(["README.txt", "Projects"]));
    expect(out.calls).toMatchObject([{ fn: "drive.files.list", status: "ok" }]);
    expect(await auditRows(out.executeId)).toHaveLength(1);
  });

  it("plans a create and a dependent public share without apply, and changes nothing at the fake", async () => {
    const { auth, email } = await driveAccount();
    const filesBefore = await driveFiles(email);
    const writesBefore = (await fake.requests(email)).filter((r) => r.method !== "GET");

    const out = await exec(auth, CREATE_AND_SHARE);

    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.result).toEqual({ id: "__gws_pending__:s1.id", perm: "__gws_pending__:s2.id" });
    expect(out.plan).toHaveLength(2);
    expect(out.plan[0]).toMatchObject({ step: "s1", fn: "drive.files.create", effect: "write", destructive: false });
    expect(out.plan[1]).toMatchObject({ step: "s2", fn: "drive.permissions.create", incomplete: true, dependsOn: ["s1"], destructive: true });
    expect(out.destructive).toBe(true);
    expect((await fake.requests(email)).filter((r) => r.method !== "GET")).toEqual(writesBefore);
    expect(await driveFiles(email)).toEqual(filesBefore);
  });

  it("applies the same snippet with apply:true: the file and its public permission exist at the fake", async () => {
    const { auth, email } = await driveAccount();
    const out = await exec(auth, CREATE_AND_SHARE, { apply: true });

    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ ok: true, applied: true, plan: [] });
    // Nothing was planned: the flag comes from the destructive call that ran.
    expect(out.destructive).toBe(true);
    const { id } = out.result as { id: string; perm: string };
    expect((await driveFiles(email)).find((f) => f.id === id)?.name).toBe("shared-report.txt");
    expect((await permissionsOf(email, id)).some((p) => p.type === "anyone")).toBe(true);
    expect((await auditRows(out.executeId)).map((r) => [r.fn, r.applied])).toEqual([
      ["drive.files.create", 1],
      ["drive.permissions.create", 1],
    ]);
  });

  it("waits for an un-awaited applied write still in flight when the snippet returns, and audits it", async () => {
    const { auth, email } = await driveAccount();
    // Calls on one RPC stub arrive in order: once the second call has answered, the write has started host-side.
    const out = await exec(
      auth,
      `async () => {
        void sdk.drive.files.create({ requestBody: { name: "unawaited.txt" } });
        await sdk.sync.point({}).catch(() => null);
        return "returned";
      }`,
      { apply: true },
    );
    expect(out.result).toBe("returned");
    const rows = await auditRows(out.executeId);
    expect(rows.map((r) => [r.fn, r.status, r.applied])).toContainEqual(["drive.files.create", "ok", 1]);
    expect((await driveFiles(email)).filter((f) => f.name === "unawaited.txt")).toHaveLength(1);
  });

  it("never runs an un-awaited write unaudited when it reaches the host after the snippet ended", async () => {
    const { auth, email } = await driveAccount();
    const out = await exec(auth, 'async () => { void sdk.drive.files.create({ requestBody: { name: "late.txt" } }); return "returned"; }', {
      apply: true,
    });
    expect(out.result).toBe("returned");
    // Refused after close (nothing sent, nothing recorded) or run and audited: never one without the other.
    const applied = (await auditRows(out.executeId)).filter((r) => r.fn === "drive.files.create" && r.applied === 1);
    expect((await driveFiles(email)).filter((f) => f.name === "late.txt")).toHaveLength(applied.length);
  });

  it("surfaces an unknown method as GWS_UNKNOWN_METHOD", async () => {
    const out = await exec(freshAuth(), "async () => sdk.drive.files.nope({})");
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("GWS_UNKNOWN_METHOD");
    expect(out.calls).toMatchObject([{ fn: "<unknown>", status: "error", code: "GWS_UNKNOWN_METHOD" }]);
  });

  it("times out a snippet that never finishes, and still writes the audit rows of its calls", async () => {
    const { auth } = await driveAccount();
    const out = await exec(auth, "async () => { await sdk.drive.files.list({}); while (true) await new Promise((r) => setTimeout(r, 20)); }", {
      config: { EXECUTE_TIMEOUT_MS: 1000 },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: "GWS_EXECUTION_TIMEOUT", details: { timeoutMs: 1000 } });
    expect((await auditRows(out.executeId)).map((r) => r.fn)).toEqual(["drive.files.list"]);
  });

  it("refuses a result larger than RESULT_MAX_BYTES with scope result", async () => {
    const out = await exec(freshAuth(), "async () => ({ big: 'x'.repeat(5000) })", { config: { RESULT_MAX_BYTES: 4096 } });
    expect(out.ok).toBe(false);
    expect(out.result).toBeUndefined();
    expect(out.error).toMatchObject({ code: "GWS_RESPONSE_TOO_LARGE", details: { scope: "result", max: 4096 } });
    const small = await exec(freshAuth(), "async () => ({ big: 'x'.repeat(4000) })", { config: { RESULT_MAX_BYTES: 4096 } });
    expect(small.ok).toBe(true);
  });

  it("caps the logs at RESULT_MAX_BYTES and says how many lines were dropped", async () => {
    const out = await exec(freshAuth(), "async () => { for (let i = 0; i < 100; i++) console.log('x'.repeat(100)); }", {
      config: { RESULT_MAX_BYTES: 1000 },
    });
    expect(out.logs).toHaveLength(10);
    expect(out.logs.at(-1)).toBe("[logs truncated: 91 more lines]");
  });

  it("returns a snippet's own error as GWS_EXECUTION_ERROR, also for a thrown non-Error or an empty message", async () => {
    expect((await exec(freshAuth(), "async () => { throw new TypeError('bad thing'); }")).error).toEqual({
      code: "GWS_EXECUTION_ERROR",
      message: "bad thing",
    });
    expect((await exec(freshAuth(), "async () => { throw 'plain'; }")).error).toEqual({
      code: "GWS_EXECUTION_ERROR",
      message: "the snippet threw a string",
    });
    expect((await exec(freshAuth(), "async () => { throw new Error(); }")).error).toEqual({ code: "GWS_EXECUTION_ERROR", message: "Error" });
    const syntax = await exec(freshAuth(), "async () => { return ( }");
    expect(syntax.ok).toBe(false);
    expect(syntax.error?.code).toBe("GWS_EXECUTION_ERROR");
  });

  it("does not take a snippet's look-alike message for an SDK error", async () => {
    const out = await exec(
      freshAuth(),
      "async () => { try { await sdk.drive.files.nope({}); } catch (e) {} throw new Error('GWS_RATE_LIMITED: fake'); }",
    );
    expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: "GWS_RATE_LIMITED: fake" });
  });

  it("lets a host-side exception reach the snippet and the output only as a structured code", async () => {
    const boom = hostFn("test.boom", async () => {
      throw new Error("raw failure: D1_ERROR at accounts table, token ya29.hostsecret");
    });
    const registry = buildRegistry([boom]);
    const caught = await exec(freshAuth(), "async () => { try { await sdk.test.boom({}); } catch (e) { return [e.code, e.message]; } }", { registry });
    expect(caught.result).toEqual(["GWS_INTERNAL", "GWS_INTERNAL: internal error"]);
    const uncaught = await exec(freshAuth(), "async () => sdk.test.boom({})", { registry });
    expect(uncaught.error).toEqual({ code: "GWS_INTERNAL", message: "internal error", fn: "test.boom" });
    expect(JSON.stringify([caught, uncaught])).not.toMatch(/raw failure|D1_ERROR|hostsecret/);
  });

  it.each([
    ["call budget", { CALLS_PER_EXECUTE: 2 }, "GWS_CALL_BUDGET_EXCEEDED", {}],
    ["rate limit", { RATE_CLIENT_PER_MIN: 2 }, "GWS_RATE_LIMITED", { scope: "client" }],
  ])("surfaces the %s as its own code", async (_name, config, code, details) => {
    const ok = hostFn("test.ok", async () => ({ ok: 1 }));
    const out = await exec(freshAuth(), "async () => { for (let i = 0; i < 3; i++) await sdk.test.ok({}); }", {
      registry: buildRegistry([ok]),
      config,
    });
    expect(out.error).toMatchObject({ code, details });
  });

  it("surfaces the per-call response cap as GWS_RESPONSE_TOO_LARGE with scope call", async () => {
    const { auth } = await driveAccount();
    const out = await exec(auth, "async () => sdk.drive.files.list({})", { config: { CALL_RESPONSE_MAX_BYTES: 100 } });
    expect(out.error).toMatchObject({ code: "GWS_RESPONSE_TOO_LARGE", details: { scope: "call", max: 100 } });
  });

  it("reports the over-budget calls that got no audit row", async () => {
    const ok = hostFn("test.ok", async () => ({ ok: 1 }));
    const out = await exec(
      freshAuth(),
      "async () => { let refused = 0; for (let i = 0; i < 6; i++) { try { await sdk.test.ok({}); } catch (e) { refused++; } } return refused; }",
      { registry: buildRegistry([ok]), config: { CALLS_PER_EXECUTE: 2 } },
    );
    expect(out.result).toBe(4);
    expect(out.unauditedRefusals).toBe(3);
    expect(await auditRows(out.executeId)).toHaveLength(3);
  });
});

describe("execute output bounds", () => {
  it("measures the logs cap on the raw lines, so redaction runs only on the lines kept", async () => {
    const out = await exec(freshAuth(), "async () => { for (let i = 0; i < 10; i++) console.log('ya29.' + 'a'.repeat(95)); }", {
      config: { RESULT_MAX_BYTES: 500 },
    });
    expect(out.logs).toEqual([...Array<string>(4).fill("[REDACTED]"), "[logs truncated: 6 more lines]"]);
  });

  it("writes the audit row of an applied write when the snippet then floods its output with a token-shaped prefix", async () => {
    const { auth, email } = await driveAccount();
    const flood = '"eyJ".repeat(100000)';
    const start = Date.now();
    const out = await exec(
      auth,
      `async () => { await sdk.drive.files.create({ requestBody: { name: "before-flood.txt" } }); console.log(${flood}); return ${flood}; }`,
      { apply: true, config: { RESULT_MAX_BYTES: 400_000 } },
    );
    expect(Date.now() - start).toBeLessThan(3000);
    expect(out.ok).toBe(true);
    expect(out.logs).toEqual(["eyJ".repeat(100_000)]);
    expect((await auditRows(out.executeId)).map((r) => [r.fn, r.applied])).toEqual([["drive.files.create", 1]]);
    expect((await driveFiles(email)).filter((f) => f.name === "before-flood.txt")).toHaveLength(1);
  });

  it("writes the audit rows before it reads the snippet output", async () => {
    const { auth } = await driveAccount();
    const events: string[] = [];
    // Every completed D1 batch (the audit rows are one), and every read of a secret value, which in fake mode
    // only the redaction of the snippet output does.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const v: unknown = Reflect.get(target, prop, target);
        if (typeof v !== "function") return v;
        if (prop !== "batch") return v.bind(target);
        return async (...args: unknown[]) => {
          const r: unknown = await v.apply(target, args);
          events.push("batch");
          return r;
        };
      },
    });
    const bindings = Object.defineProperty({ ...env, DB: db }, "GOOGLE_CLIENT_SECRET", {
      get: () => {
        events.push("secret read");
        return env.GOOGLE_CLIENT_SECRET;
      },
    });
    const out = await exec(auth, "async () => { await sdk.drive.files.list({}); return 1; }", { bindings });
    expect(out.result).toBe(1);
    expect(await auditRows(out.executeId)).toHaveLength(1);
    expect(events.lastIndexOf("secret read")).toBeGreaterThan(events.lastIndexOf("batch"));
    expect(events).toContain("batch");
  });

  it("keeps the dry-run output of three 1 MB writes within RESULT_MAX_BYTES, each planned body stored as its size", async () => {
    const { auth } = await driveAccount();
    const out = await exec(
      auth,
      `async () => { for (let i = 0; i < 3; i++) await sdk.drive.files.create({ requestBody: { description: "a".repeat(1e6) } }); return "planned"; }`,
    );
    expect(out).toMatchObject({ ok: true, result: "planned" });
    expect(out.plan.map((p) => p.request?.body)).toEqual(Array(3).fill({ bytes: expect.any(Number), truncated: true }));
    expect(jsonBytes(out)).toBeLessThanOrEqual(baseConfig.RESULT_MAX_BYTES);
  });

  it("bounds the whole plan at RESULT_MAX_BYTES by dropping the requests of the later steps", async () => {
    const { auth } = await driveAccount();
    const out = await exec(
      auth,
      `async () => { for (let i = 0; i < 6; i++) await sdk.drive.files.create({ requestBody: { name: "f" + i, description: "a".repeat(15000) } }); }`,
      { config: { RESULT_MAX_BYTES: 50_000 } },
    );
    expect(out.ok).toBe(true);
    expect(out.plan).toHaveLength(6);
    expect(jsonBytes(out.plan)).toBeLessThanOrEqual(50_000);
    expect(out.plan.map((p) => p.request !== undefined)).toEqual([true, true, true, false, false, false]);
    expect(out.plan[5]).toMatchObject({ step: "s6", fn: "drive.files.create", effect: "write", note: expect.stringMatching(/request omitted/) });
  });

  it("refuses a result whose JSON text is over twice RESULT_MAX_BYTES before parsing it, even when redaction would shrink it", async () => {
    const over = await exec(freshAuth(), "async () => 'ya29.' + 'a'.repeat(9000)", { config: { RESULT_MAX_BYTES: 4096 } });
    expect(over.error).toMatchObject({ code: "GWS_RESPONSE_TOO_LARGE", details: { scope: "result", max: 4096 } });
    const within = await exec(freshAuth(), "async () => 'ya29.' + 'a'.repeat(7000)", { config: { RESULT_MAX_BYTES: 4096 } });
    expect(within).toMatchObject({ ok: true, result: "[REDACTED]" });
  });

  it("refuses a result that is not the wrapper's JSON text, also when the snippet replaces JSON.stringify", async () => {
    const out = await exec(freshAuth(), "async () => { JSON.stringify = () => 42; return 1; }");
    expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: "the snippet result is not JSON-serializable" });
    expect(out.result).toBeUndefined();
  });
});

describe("execute deadlines and rate", () => {
  it(
    "ends a snippet that disables its own timer at the host deadline, and accepts no SDK call after it",
    async () => {
      let lateRuns = 0;
      const late = hostFn("test.late", async () => {
        lateRuns += 1;
        return {};
      });
      const start = Date.now();
      const out = await exec(
        freshAuth(),
        `async () => {
          const st = setTimeout;
          globalThis.setTimeout = () => 0;
          await new Promise((r) => st(r, 2000));
          await sdk.test.late({});
          return "survived";
        }`,
        { registry: buildRegistry([late]), config: { EXECUTE_TIMEOUT_MS: 500 } },
      );
      expect(out.error).toMatchObject({ code: "GWS_EXECUTION_TIMEOUT", details: { timeoutMs: 500 } });
      expect(Date.now() - start).toBeLessThan(500 + HOST_DEADLINE_GRACE_MS + 500);
      // The sandbox wakes at 2 s and tries its call: the closed session must refuse it.
      await new Promise((r) => setTimeout(r, 2500));
      expect(lateRuns).toBe(0);
      expect(out.calls).toEqual([]);
    },
    15_000,
  );

  it("gives the Worker Loader child a CPU limit", async () => {
    const seen: unknown[] = [];
    const loader: WorkerLoader = {
      load: (code) => {
        seen.push(code.limits);
        return env.LOADER.load(code);
      },
      get: (name, getCode) => env.LOADER.get(name, getCode),
    };
    const run = await runSandbox({ sandbox: workersSandbox(loader), timeoutMs: 5000, cpuMs: 1234, code: "async () => 7", call: async () => null });
    expect(run).toMatchObject({ status: "returned", json: "7" });
    expect(seen).toEqual([{ cpuMs: 1234 }]);
  });

  it("runs every execute under EXECUTE_CPU_MS and maps a child over its CPU limit to GWS_EXECUTION_TIMEOUT", async () => {
    expect(EXECUTE_CPU_MS).toBe(5000);
    const seen: unknown[] = [];
    const out = await exec(freshAuth(), "async () => 1", { bindings: { ...env, LOADER: cpuExceededLoader(seen) } });
    expect(seen).toEqual([{ cpuMs: EXECUTE_CPU_MS }]);
    expect(out.error).toMatchObject({ code: "GWS_EXECUTION_TIMEOUT", details: { cpuMs: EXECUTE_CPU_MS } });
  });

  it("counts each execute once against the rate limit, also one that makes no SDK call", async () => {
    const auth = freshAuth();
    // A fixed instant 10 s into a rate window, so the three executes share one window.
    const now = () => Date.UTC(2026, 10, 9, 6, 0, 10);
    const run = () => exec(auth, "async () => 1", { config: { RATE_CLIENT_PER_MIN: 2 }, now });
    expect((await run()).result).toBe(1);
    expect((await run()).result).toBe(1);
    const third = await run();
    expect(third.error).toMatchObject({ code: "GWS_RATE_LIMITED", details: { scope: "client" } });
    expect(third.result).toBeUndefined();
    expect(third.calls).toEqual([]);
  });
});

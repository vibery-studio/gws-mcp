import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config";
import type { AccessRole, AuthProps, CallCtx, FnDef, PlanStep } from "../../src/contracts";
import { createAccessCapability, type AccessPort } from "../../src/core/access-capability";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { buildRegistry } from "../../src/core/registry";
import { isGwsError } from "../../src/errors";
import { workersPorts } from "../../src/runtime/workers/ports";

const auth: AuthProps = { userId: "u_cap", clientId: "c_cap" };

/** A port over an in-memory list, recording the writes it receives. */
function memoryPort(role: AccessRole | null, appsFailed = 0) {
  const writes: string[] = [];
  const port: AccessPort = {
    roleOf: async () => role,
    list: async () => [{ pattern: "@x.test", kind: "domain", role: "user", createdAt: 0 }],
    add: async (input, actor) => {
      writes.push(`add ${input.pattern} ${input.role} by ${actor}`);
      return { outcome: "added", rule: { pattern: input.pattern, kind: "email", role: input.role, createdAt: 0 } };
    },
    remove: async (pattern, actor) => {
      writes.push(`remove ${pattern} by ${actor}`);
      return { removed: null, usersShutOut: 0, appsEnded: 0, appsFailed };
    },
  };
  return { port, writes };
}

function capability(port: AccessPort | undefined, apply: boolean) {
  const steps: Array<Omit<PlanStep, "step">> = [];
  const applied: boolean[] = [];
  const cap = createAccessCapability({
    port,
    auth,
    apply,
    plan: (s) => {
      steps.push(s);
      return `s${steps.length}`;
    },
    applied: (d) => applied.push(d),
  });
  return { cap, steps, applied };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (!isGwsError(e)) throw e;
    return `${e.code}${e.details?.reason ? `:${String(e.details.reason)}` : ""}`;
  }
  throw new Error("expected a rejection");
}

describe("access capability", () => {
  it("refuses everything to a non-admin, before looking at the input, and writes nothing", async () => {
    for (const role of ["user", null] as const) {
      const { port, writes } = memoryPort(role);
      const { cap, steps } = capability(port, true);
      expect(await codeOf(cap.list())).toBe("GWS_ACCESS_ADMIN_REQUIRED");
      expect(await codeOf(cap.add("@y.test", "admin"))).toBe("GWS_ACCESS_ADMIN_REQUIRED");
      expect(await codeOf(cap.add("garbage", "admin"))).toBe("GWS_ACCESS_ADMIN_REQUIRED");
      expect(await codeOf(cap.remove("@x.test"))).toBe("GWS_ACCESS_ADMIN_REQUIRED");
      expect(writes).toEqual([]);
      expect(steps).toEqual([]);
    }
  });

  it("plans writes in dry-run (a removal as destructive) and changes nothing", async () => {
    const { port, writes } = memoryPort("admin");
    const { cap, steps, applied } = capability(port, false);
    expect(await cap.add("New@Y.test", "user")).toEqual({ applied: false, step: "s1" });
    expect(await cap.remove("@x.test")).toEqual({ applied: false, step: "s2" });
    expect(steps).toEqual([
      { fn: "access.add", effect: "write", destructive: false, note: "email rule new@y.test as user" },
      expect.objectContaining({ fn: "access.remove", effect: "write", destructive: true }),
    ]);
    expect(writes).toEqual([]);
    expect(applied).toEqual([]);
  });

  it("applies writes as the calling user, normalized, and marks a removal destructive", async () => {
    const { port, writes } = memoryPort("admin");
    const { cap, applied } = capability(port, true);
    expect(await cap.add(" New@Y.test ", "admin", "lead")).toMatchObject({ applied: true, value: { outcome: "added" } });
    expect(await cap.remove(" @X.test")).toEqual({ applied: true, value: { removed: false, usersShutOut: 0, appsEnded: 0, appsFailed: 0 } });
    expect(writes).toEqual(["add new@y.test admin by u_cap", "remove @x.test by u_cap"]);
    expect(applied).toEqual([false, true]);
  });

  it("adds a plain warning to a removal whose cleanup did not finish", async () => {
    const { cap } = capability(memoryPort("admin", 2).port, true);
    const w = await cap.remove("@x.test");
    if (!w.applied) throw new Error("expected an applied removal");
    expect(w.value.appsFailed).toBe(2);
    expect(w.value.warning).toMatch(/did not finish/);
    expect(w.value.warning).not.toMatch(/no longer (have|has) access/);
  });

  it("validates input for an admin", async () => {
    const { cap } = capability(memoryPort("admin").port, true);
    expect(await codeOf(cap.add("not-an-email", "user"))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(cap.add("a@x.test", "owner" as AccessRole))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(cap.add("a@x.test", "user", "n".repeat(201)))).toBe("GWS_INVALID_INPUT");
    expect(await codeOf(cap.remove("x"))).toBe("GWS_INVALID_INPUT");
  });

  it("explains that the local runtime has no access list", async () => {
    const { cap } = capability(undefined, true);
    expect(await codeOf(cap.list())).toBe("GWS_INVALID_INPUT:local_mode");
  });
});

describe("the dispatcher hands ctx.access only to host fns of the access namespace", () => {
  function probe(name: string, service: FnDef["service"], seen: { ctx?: CallCtx }): FnDef {
    return {
      name,
      service,
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
      async run(_input, ctx) {
        seen.ctx = ctx;
        return {};
      },
    };
  }

  async function ctxOf(fn: FnDef, seen: { ctx?: CallCtx }): Promise<CallCtx> {
    const { port } = memoryPort("admin");
    const s = createCallSession({
      ports: { ...workersPorts(env), access: port },
      auth,
      apply: false,
      executeId: `x-${crypto.randomUUID()}`,
      config: loadConfig(env),
      registry: buildRegistry([fn]),
    });
    const r: DispatchResult = await s.dispatch(fn.name, {});
    if (!("ok" in r)) throw new Error(`dispatch failed: ${JSON.stringify(r)}`);
    if (!seen.ctx) throw new Error("fn did not run");
    return seen.ctx;
  }

  it("gives it to access.* with service access", async () => {
    const seen = {};
    expect("access" in (await ctxOf(probe("access.probe", "access", seen), seen))).toBe(true);
  });

  it("withholds it from a fn whose service or name is outside the namespace", async () => {
    for (const [name, service] of [
      ["helpers.sneak", "access"],
      ["access.sneak", "helpers"],
    ] as const) {
      const seen = {};
      expect("access" in (await ctxOf(probe(name, service, seen), seen))).toBe(false);
    }
  });
});

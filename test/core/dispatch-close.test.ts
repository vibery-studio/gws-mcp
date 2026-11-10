import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../../src/config";
import type { AuthProps, CallCtx, FnDef } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { buildRegistry, getRegistry, type Registry } from "../../src/core/registry";
import { isGwsError } from "../../src/errors";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const store = openStore(env);
const baseConfig = loadConfig(env);

async function driveAccount() {
  const email = uniqueEmail("disp-close");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { ...seeded, email, auth };
}

function session(auth: AuthProps, o: { apply?: boolean; config?: Partial<Config>; registry?: Registry } = {}) {
  const executeId = `x-${crypto.randomUUID()}`;
  const s = createCallSession({
    ports: workersPorts(env),
    auth,
    apply: o.apply ?? false,
    executeId,
    config: { ...baseConfig, ...o.config },
    ...(o.registry ? { registry: o.registry } : {}),
  });
  return { s, executeId };
}

async function rowsFor(executeId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
  return results;
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
const ok = hostFn("test.ok", async () => ({ ok: 1 }));

describe("session close", () => {
  it("audits an applied write the snippet never awaited", async () => {
    const { auth, email, account } = await driveAccount();
    const { s, executeId } = session(auth, { apply: true });
    void s.dispatch("drive.files.create", { requestBody: { name: "unawaited.txt" } });
    await s.close();
    const rows = await rowsFor(executeId);
    expect(rows.map((r) => [r.fn, r.status, r.applied, r.upstream_status, r.account_id])).toEqual([
      ["drive.files.create", "ok", 1, 200, account.id],
    ]);
    const files = Object.values((await fake.state(email)).resources) as Array<{ name?: string }>;
    expect(files.some((f) => f?.name === "unawaited.txt")).toBe(true);
  });

  it("refuses calls after close with a structured error, without running or recording them", async () => {
    const { auth, email } = await driveAccount();
    const { s, executeId } = session(auth, { apply: true });
    await s.close();
    const logBefore = await fake.requests(email);
    const r = await s.dispatch("drive.files.create", { requestBody: { name: "late.txt" } });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_EXECUTION_ERROR");
    expect(await fake.requests(email)).toEqual(logBefore);
    expect(s.calls).toEqual([]);
    await s.close();
    expect(await rowsFor(executeId)).toEqual([]);
  });

  it("refuses a nested call a host fn detaches past the end of its own call once the session is closed", async () => {
    let later: Promise<unknown> | undefined;
    const detach = hostFn("test.detach", async (_i, ctx) => {
      later = new Promise((resolve) => setTimeout(resolve, 20)).then(() => ctx.call("test.ok", {}));
      return {};
    });
    const { s, executeId } = session(freshAuth(), { registry: buildRegistry([ok, detach]) });
    await s.dispatch("test.detach", {});
    await s.close();
    let caught: unknown;
    try {
      await later;
    } catch (e) {
      caught = e;
    }
    expect(isGwsError(caught) && caught.code).toBe("GWS_EXECUTION_ERROR");
    expect((await rowsFor(executeId)).map((r) => r.fn)).toEqual(["test.detach"]);
  });

  it("lets nested calls of a host fn still running at close finish and be audited", async () => {
    const slow = hostFn("test.slow", async (_i, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ctx.call("test.ok", {});
    });
    const { s, executeId } = session(freshAuth(), { registry: buildRegistry([ok, slow]) });
    void s.dispatch("test.slow", {});
    await s.close();
    expect((await rowsFor(executeId)).map((r) => [r.fn, r.status])).toEqual([
      ["test.ok", "ok"],
      ["test.slow", "ok"],
    ]);
  });

  it("records a call still running when the wait runs out as a timeout, so it is never missing from the audit", async () => {
    const hang = hostFn("test.hang", () => new Promise(() => undefined));
    const { s, executeId } = session(freshAuth(), { registry: buildRegistry([hang]) });
    void s.dispatch("test.hang", {});
    await s.close({ waitMs: 30 });
    expect((await rowsFor(executeId)).map((r) => [r.fn, r.status, r.code])).toEqual([["test.hang", "error", "GWS_EXECUTION_TIMEOUT"]]);
  });

  it("flushes once even when closed twice concurrently", async () => {
    const { s, executeId } = session(freshAuth(), { registry: buildRegistry([ok]) });
    await s.dispatch("test.ok", {});
    await Promise.all([s.close(), s.close()]);
    expect(await rowsFor(executeId)).toHaveLength(1);
  });
});

describe("session output for execute", () => {
  it("counts the budget refusals that were not audited", async () => {
    const { s } = session(freshAuth(), { config: { CALLS_PER_EXECUTE: 2 }, registry: buildRegistry([ok]) });
    expect(s.unauditedRefusals).toBe(0);
    for (let i = 0; i < 3; i++) await s.dispatch("test.ok", {});
    expect(s.unauditedRefusals).toBe(0);
    for (let i = 0; i < 17; i++) await s.dispatch("test.ok", {});
    expect(s.unauditedRefusals).toBe(17);
  });

  it("reports whether a destructive call actually ran under apply", async () => {
    const { auth } = await driveAccount();
    const dry = session(auth).s;
    await dry.dispatch("drive.files.delete", { fileId: "seed-file-readme" });
    expect(dry.destructive).toBe(true);
    expect(dry.appliedDestructive).toBe(false);

    const safe = session(auth, { apply: true }).s;
    await safe.dispatch("drive.files.create", { requestBody: { name: "safe.txt" } });
    expect(safe.appliedDestructive).toBe(false);

    const applied = session(auth, { apply: true }).s;
    const r: DispatchResult = await applied.dispatch("drive.files.delete", { fileId: "seed-file-readme" });
    expect("ok" in r).toBe(true);
    expect(applied.destructive).toBe(false);
    expect(applied.appliedDestructive).toBe(true);
  });

  it("does not count a destructive write that failed before it was sent", async () => {
    const { auth } = await driveAccount();
    const { s } = session(auth, { apply: true, registry: buildRegistry([...getRegistry().values()]) });
    const r = await s.dispatch("drive.files.delete", { fileId: "trash" });
    expect("__gwsError" in r).toBe(true);
    expect(s.appliedDestructive).toBe(false);
  });
});

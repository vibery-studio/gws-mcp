import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { PENDING_TOKEN_PREFIX, type AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { getRegistry } from "../../src/core/registry";
import { search } from "../../src/core/search";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const ADD = "tasks.addTask";
const store = openStore(env);
const baseConfig = loadConfig(env);
const pending = (ref: string) => `${PENDING_TOKEN_PREFIX}${ref}`;

async function client(scopes: string[] = [`${G}tasks`]) {
  const email = uniqueEmail("h-task");
  const seeded = await seedUserWithAccount(env, { email, scopes, isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

function session(auth: AuthProps, apply: boolean) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config: baseConfig }), executeId };
}

function valueOf(r: DispatchResult): Record<string, unknown> {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

async function titles(auth: AuthProps): Promise<string[]> {
  const { s } = session(auth, false);
  const items = (valueOf(await s.dispatch("tasks.tasks.list", { tasklist: "@default" })).items as Array<{ title?: string }> | undefined) ?? [];
  return items.map((t) => t.title ?? "");
}

describe("tasks.addTask", () => {
  it("is a write helper with a signature, example and tags, and search ranks it first", () => {
    const fn = getRegistry().get(ADD);
    expect(fn).toMatchObject({ kind: "host", service: "helpers", effect: "write" });
    expect(fn?.signature).toContain(`${ADD}(`);
    expect(fn?.signature).toContain("Promise<");
    expect(fn?.example).toContain(`await sdk.${ADD}(`);
    expect(fn?.tags).toContain("write");
    expect(fn?.tsDecl.length).toBeGreaterThan(20);
    const top = search({ query: "add a task to my todo list" }, [...getRegistry().values()], { SEARCH_MAX_BYTES: 8000 }).map((r) => r.name);
    expect(top[0]).toBe(ADD);
  });

  it("dry-run plans one insert into the default list and changes nothing", async () => {
    const { email, auth } = await client();
    const before = await titles(auth);
    const logBefore = (await fake.requests(email)).length;
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch(ADD, { title: "Buy milk", notes: "2 litres", due: "2026-11-20" }));

    expect(out).toEqual({ applied: false, step: "s1" });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ step: "s1", fn: "tasks.tasks.insert", account: email, effect: "write", destructive: false });
    expect(s.plan[0]?.request?.method).toBe("POST");
    expect(s.plan[0]?.request?.url).toContain("/tasks/v1/lists/%40default/tasks");
    expect(s.plan[0]?.request?.body).toEqual({ title: "Buy milk", notes: "2 litres", due: "2026-11-20T00:00:00.000Z" });
    expect(await fake.requests(email)).toHaveLength(logBefore);
    expect(await titles(auth)).toEqual(before);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([["tasks.tasks.insert", 0], [ADD, 0]]);
  });

  it("apply creates the task and tasks.list shows it", async () => {
    const { auth } = await client();
    const { s, executeId } = session(auth, true);

    const out = valueOf(await s.dispatch(ADD, { title: "Buy milk", notes: "2 litres", due: "2026-11-20T15:30:00Z" }));

    expect(out).toMatchObject({ applied: true, title: "Buy milk", notes: "2 litres", status: "needsAction", due: "2026-11-20T00:00:00.000Z" });
    expect(typeof out.id).toBe("string");
    expect(await titles(auth)).toContain("Buy milk");

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([["tasks.tasks.insert", 1], [ADD, 1]]);
  });

  it("adds to a named task list", async () => {
    const { auth } = await client();
    const out = valueOf(await session(auth, true).s.dispatch(ADD, { title: "Ship it", tasklist: "seed-tasklist-default" }));
    expect(out).toMatchObject({ applied: true, title: "Ship it" });
    expect(await titles(auth)).toContain("Ship it");
  });

  it("fails with GWS_SCOPE_MISSING when the account lacks the tasks scope, and sends nothing", async () => {
    const { email, auth } = await client([`${G}spreadsheets`]);
    const logBefore = (await fake.requests(email)).length;
    const r = await session(auth, true).s.dispatch(ADD, { title: "Buy milk" });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_SCOPE_MISSING");
    expect(await fake.requests(email)).toHaveLength(logBefore);
  });

  it("rejects a missing title, a bad due date and unknown fields", async () => {
    const { auth } = await client();
    const { s } = session(auth, true);
    for (const bad of [
      {},
      { title: "" },
      { title: "x", due: "tomorrow" },
      { title: "x", due: "2026-13-45" },
      { title: "x", extra: true },
    ]) {
      const r = await s.dispatch(ADD, bad);
      expect("__gwsError" in r && r.__gwsError.code, JSON.stringify(bad)).toBe("GWS_INVALID_INPUT");
    }
  });

  it("plans a task in a list created in the same dry-run as incomplete, and runs neither", async () => {
    const { email, auth } = await client();
    const { s } = session(auth, false);
    expect(await s.dispatch("tasks.tasklists.insert", { requestBody: { title: "Errands" } })).toEqual({ __gwsPending: "s1" });
    const r = await s.dispatch(ADD, { title: "Buy milk", tasklist: pending("s1.id") });
    expect(r).toEqual({ __gwsPending: "s2" });
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: ADD, effect: "write", incomplete: true, dependsOn: ["s1"] });
    expect(s.plan.some((p) => p.fn === "tasks.tasks.insert")).toBe(false);
    const writes = (await fake.requests(email)).filter((q) => q.method === "POST" && q.path.startsWith("/tasks.googleapis.com/"));
    expect(writes).toEqual([]);
  });
});

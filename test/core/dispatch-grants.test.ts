import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config";
import type { AuthProps, CallCtx, FnDef } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { buildRegistry, getRegistry, type Registry } from "../../src/core/registry";
import type { WireError } from "../../src/errors";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const LIST = "gmail.users.messages.list";
const store = openStore(env);
const baseConfig = loadConfig(env);

/** One user with accounts A (default, alias "work") and B; client A is allowlisted for A only. */
async function twoAccounts() {
  const emailA = uniqueEmail("grant-a");
  const emailB = uniqueEmail("grant-b");
  const a = await seedUserWithAccount(env, { email: emailA, scopes: [GMAIL_RO], alias: "work", isDefault: true });
  const b = await seedUserWithAccount(env, { email: emailB, scopes: [GMAIL_RO], userId: a.userId });
  const clientA: AuthProps = { userId: a.userId, clientId: `client-a-${crypto.randomUUID()}` };
  await store.grants.add(a.userId, clientA.clientId, a.account.id);
  return { a, b, emailA, emailB, clientA };
}

function session(auth: AuthProps, registry?: Registry) {
  return createCallSession({
    ports: workersPorts(env),
    auth,
    apply: false,
    executeId: `x-${crypto.randomUUID()}`,
    config: baseConfig,
    ...(registry ? { registry } : {}),
  });
}

function errorOf(r: DispatchResult): WireError {
  if (!("__gwsError" in r)) throw new Error(`expected an error result, got ${JSON.stringify(r)}`);
  return r.__gwsError;
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value;
}

function probe(name: string, run: (input: Record<string, unknown>, ctx: CallCtx) => Promise<unknown>): FnDef {
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
    run: run as FnDef["run"],
  };
}

describe("client allowlist", () => {
  it("lets a client allowlisted for A call A and denies B, before any upstream request for B", async () => {
    const { emailA, emailB, clientA } = await twoAccounts();
    const s = session(clientA);
    valueOf(await s.dispatch(LIST, { userId: "me", account: emailA }));

    const logB = await fake.requests(emailB);
    const err = errorOf(await s.dispatch(LIST, { userId: "me", account: emailB }));
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
    expect(err.details).toEqual({ account: emailB });
    expect(await fake.requests(emailB)).toEqual(logB);
    expect(s.calls.map((c) => [c.status, c.account])).toEqual([
      ["ok", emailA],
      ["denied", undefined],
    ]);
  });

  it("denies a dry-run write on a non-allowlisted account, so no plan step is made for it", async () => {
    const { emailB, clientA } = await twoAccounts();
    const s = session(clientA);
    const err = errorOf(await s.dispatch("gmail.users.messages.trash", { userId: "me", id: "m1", account: emailB }));
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
    expect(s.plan).toEqual([]);
  });

  it("resolves the default account when account is omitted, and an alias", async () => {
    const { emailA, clientA } = await twoAccounts();
    const s = session(clientA);
    valueOf(await s.dispatch(LIST, { userId: "me" }));
    valueOf(await s.dispatch(LIST, { userId: "me", account: "work" }));
    expect(s.calls.map((c) => c.account)).toEqual([emailA, emailA]);
  });

  it("applies the default only when it is in the client's allowlist", async () => {
    const { a, b, clientA } = await twoAccounts();
    await store.accounts.setDefault(a.userId, b.account.id);
    const err = errorOf(await session(clientA).dispatch(LIST, { userId: "me" }));
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
    expect(err.details).toEqual({ account: "default" });
  });

  it("checks the allowlist on every call, not once per session", async () => {
    const { a, emailA, clientA } = await twoAccounts();
    const s = session(clientA);
    valueOf(await s.dispatch(LIST, { userId: "me", account: emailA }));
    await store.grants.remove(a.userId, clientA.clientId, a.account.id);
    expect(errorOf(await s.dispatch(LIST, { userId: "me", account: emailA })).code).toBe("GWS_ACCOUNT_DENIED");
  });

  it("keeps each client's allowlist separate", async () => {
    const { a, b, emailB } = await twoAccounts();
    const clientB: AuthProps = { userId: a.userId, clientId: `client-b-${crypto.randomUUID()}` };
    await store.grants.add(a.userId, clientB.clientId, b.account.id);
    valueOf(await session(clientB).dispatch(LIST, { userId: "me", account: emailB }));
  });

  it("does not reveal a non-allowlisted account's state: reconnect on B is still a denial", async () => {
    const { a, b, emailB, clientA } = await twoAccounts();
    await store.accounts.markStatus(a.userId, b.account.id, "reconnect");
    const err = errorOf(await session(clientA).dispatch(LIST, { userId: "me", account: emailB }));
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
  });

  it("never resolves another user's account", async () => {
    const { clientA } = await twoAccounts();
    const other = await seedUserWithAccount(env, { email: uniqueEmail("grant-other"), scopes: [GMAIL_RO] });
    const err = errorOf(await session(clientA).dispatch(LIST, { userId: "me", account: other.account.email }));
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
  });

  it("enforces the same allowlist for host fns through ctx.resolveAllowed and nested ctx.call", async () => {
    const { emailA, emailB, clientA } = await twoAccounts();
    const reg = buildRegistry([
      ...getRegistry().values(),
      probe("test.resolve", async (i, ctx) => ctx.resolveAllowed(i.ref as string | undefined)),
      probe("test.nested", async (i, ctx) => ctx.call(LIST, { userId: "me", account: i.ref })),
    ]);
    const s = session(clientA, reg);
    const resolved = valueOf(await s.dispatch("test.resolve", { ref: "work" }));
    expect(resolved).toMatchObject({ email: emailA, alias: "work" });
    expect(Object.keys(resolved as object).sort()).toEqual(["alias", "email", "id", "scopes"]);
    expect(errorOf(await s.dispatch("test.resolve", { ref: emailB })).code).toBe("GWS_ACCOUNT_DENIED");
    expect(errorOf(await s.dispatch("test.nested", { ref: emailB })).code).toBe("GWS_ACCOUNT_DENIED");
    expect(s.calls.map((c) => [c.fn, c.status])).toEqual([
      ["test.resolve", "ok"],
      ["test.resolve", "denied"],
      [LIST, "denied"],
      ["test.nested", "denied"],
    ]);
  });
});

describe("no account-existence oracle", () => {
  /** The error a client of `user` gets for `ref`; `ref` itself is the only thing a denial echoes. */
  async function denial(auth: AuthProps, ref: string | undefined): Promise<WireError> {
    return errorOf(await session(auth).dispatch(LIST, ref === undefined ? { userId: "me" } : { userId: "me", account: ref }));
  }

  it("gives the same error for the same ref whether the account exists but is not allowlisted, or does not exist", async () => {
    const { emailB, clientA } = await twoAccounts();
    // emailB exists for clientA's user but is not allowlisted; for a client of an unrelated user it does not exist.
    const stranger = await seedUserWithAccount(env, { email: uniqueEmail("grant-stranger"), scopes: [GMAIL_RO] });
    const strangerClient: AuthProps = { userId: stranger.userId, clientId: `client-s-${crypto.randomUUID()}` };
    await store.grants.add(stranger.userId, strangerClient.clientId, stranger.account.id);

    const existing = await denial(clientA, emailB);
    const missing = await denial(strangerClient, emailB);
    expect(existing.code).toBe("GWS_ACCOUNT_DENIED");
    expect(missing).toEqual(existing);
  });

  it("gives identical errors for an existing non-allowlisted ref and a made-up ref, apart from the echoed ref", async () => {
    const { emailB, clientA } = await twoAccounts();
    const madeUp = uniqueEmail("grant-made-up");
    const existing = await denial(clientA, emailB);
    const missing = await denial(clientA, madeUp);
    expect(existing.details).toEqual({ account: emailB });
    expect(missing.details).toEqual({ account: madeUp });
    expect({ ...missing, details: undefined }).toEqual({ ...existing, details: undefined });
  });

  it("gives the same error for an existing alias of a non-allowlisted account and an unknown alias", async () => {
    const { a, b, clientA } = await twoAccounts();
    await store.accounts.setAlias(a.userId, b.account.id, "home");
    const existing = await denial(clientA, "home");
    const otherClient: AuthProps = { userId: a.userId, clientId: `client-x-${crypto.randomUUID()}` };
    await store.grants.add(a.userId, otherClient.clientId, a.account.id);
    await store.accounts.setAlias(a.userId, b.account.id, null);
    expect(await denial(otherClient, "home")).toEqual(existing);
  });

  it("gives the same error for a missing default and a default that is not allowlisted", async () => {
    const { a, b, clientA } = await twoAccounts();
    await store.accounts.setDefault(a.userId, b.account.id);
    const notAllowed = await denial(clientA, undefined);
    const noDefault = await seedUserWithAccount(env, { email: uniqueEmail("grant-nodefault"), scopes: [GMAIL_RO], isDefault: false });
    const noDefaultClient: AuthProps = { userId: noDefault.userId, clientId: `client-n-${crypto.randomUUID()}` };
    await store.grants.add(noDefault.userId, noDefaultClient.clientId, noDefault.account.id);
    const missing = await denial(noDefaultClient, undefined);
    expect(notAllowed).toMatchObject({ code: "GWS_ACCOUNT_DENIED", details: { account: "default" } });
    expect(missing).toEqual(notAllowed);
  });

  it("gives the same error for a non-allowlisted account in reconnect state as for an unknown one", async () => {
    const { a, b, emailB, clientA } = await twoAccounts();
    const before = await denial(clientA, emailB);
    await store.accounts.markStatus(a.userId, b.account.id, "reconnect");
    expect(await denial(clientA, emailB)).toEqual(before);
  });

});

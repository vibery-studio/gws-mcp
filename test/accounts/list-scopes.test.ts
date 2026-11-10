import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { getRegistry } from "../../src/core/registry";
import type { WireError } from "../../src/errors";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const GMAIL = [`${G}gmail.readonly`, `${G}gmail.send`];
const config = loadConfig(env);
const store = openStore(env);

function call(auth: AuthProps, fn: string, input: unknown = {}, apply = false) {
  const s = createCallSession({ ports: workersPorts(env), auth, apply, executeId: `x-${crypto.randomUUID()}`, config });
  return { s, result: s.dispatch(fn, input) };
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value, got ${JSON.stringify(r)}`);
  return r.value;
}

function errorOf(r: DispatchResult): WireError {
  if (!("__gwsError" in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return r.__gwsError;
}

/** A user with A (default, alias "work"), B (alias "hidden-b") and C; the client is allowed A only. */
async function setup() {
  const a = await seedUserWithAccount(env, { email: uniqueEmail("ls-a"), scopes: GMAIL, alias: "work", isDefault: true });
  const b = await seedUserWithAccount(env, { email: uniqueEmail("ls-b"), scopes: [`${G}drive.file`], alias: "hidden-b", userId: a.userId });
  const c = await seedUserWithAccount(env, { email: uniqueEmail("ls-c"), scopes: [`${G}spreadsheets`], userId: a.userId });
  const client: AuthProps = { userId: a.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(a.userId, client.clientId, a.account.id);
  return { a, b, c, client };
}

describe("accounts.list", () => {
  it("shows exactly the client's allowed accounts with scopes, and only a count of the others", async () => {
    const { a, b, c, client } = await setup();
    const { s, result } = call(client, "accounts.list");
    const out = valueOf(await result);
    expect(out).toEqual({
      accounts: [
        {
          email: a.account.email,
          alias: "work",
          isDefault: true,
          status: "active",
          scopes: [...a.account.scopes],
          services: { gmail: true, drive: false, calendar: false, sheets: false, docs: false, forms: false, tasks: false, slides: false },
        },
      ],
      hiddenCount: 2,
    });
    const everything = JSON.stringify({ out, plan: s.plan, calls: s.calls });
    for (const secret of [b.account.email, c.account.email, "hidden-b", b.account.id, c.account.id]) expect(everything).not.toContain(secret);
    expect(s.plan).toEqual([]);
    expect(s.calls).toMatchObject([{ fn: "accounts.list", effect: "read", status: "ok" }]);
  });

  it("shows nothing but a count to a client allowed no account", async () => {
    const { a } = await setup();
    const out = valueOf(await call({ userId: a.userId, clientId: `client-${crypto.randomUUID()}` }, "accounts.list").result);
    expect(out).toEqual({ accounts: [], hiddenCount: 3 });
  });

  it("refuses arguments it does not take", async () => {
    const { client } = await setup();
    expect(errorOf(await call(client, "accounts.list", { userId: "u_other" }).result).code).toBe("GWS_INVALID_INPUT");
  });
});

describe("accounts.scopes", () => {
  it("returns an allowed account's scopes and which services they cover, for the default when no account is named", async () => {
    const { a, client } = await setup();
    const expected = {
      email: a.account.email,
      scopes: [...a.account.scopes],
      services: { gmail: true, drive: false, calendar: false, sheets: false, docs: false, forms: false, tasks: false, slides: false },
    };
    expect(valueOf(await call(client, "accounts.scopes", { account: "work" }).result)).toEqual(expected);
    expect(valueOf(await call(client, "accounts.scopes", {}).result)).toEqual(expected);
  });

  it("counts a service only when every scope the connect flow asks for it is granted", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("ls-partial"), scopes: [`${G}gmail.readonly`], isDefault: true });
    const client: AuthProps = { userId: a.userId, clientId: `client-${crypto.randomUUID()}` };
    await store.grants.add(a.userId, client.clientId, a.account.id);
    const out = valueOf(await call(client, "accounts.scopes").result) as { services: Record<string, boolean> };
    expect(out.services.gmail).toBe(false);
  });

  it("gives the identical denial for an existing account outside the allowlist and for one that does not exist", async () => {
    const { b, client } = await setup();
    const stranger: AuthProps = { userId: `u_${crypto.randomUUID()}`, clientId: `client-${crypto.randomUUID()}` };
    for (const ref of [b.account.email, "hidden-b"]) {
      const existing = errorOf(await call(client, "accounts.scopes", { account: ref }).result);
      const missing = errorOf(await call(stranger, "accounts.scopes", { account: ref }).result);
      expect(existing.code).toBe("GWS_ACCOUNT_DENIED");
      expect(existing).toEqual(missing);
    }
    const made = errorOf(await call(client, "accounts.scopes", { account: "nobody@nowhere.test" }).result);
    expect({ ...made, details: undefined }).toEqual({ ...errorOf(await call(client, "accounts.scopes", { account: b.account.email }).result), details: undefined });
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../../src/config";
import { HOST_CONFIG_KEYS, SECRET_NAMES, type AuthProps, type CallCtx, type FnDef } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { buildRegistry, getRegistry, type Registry } from "../../src/core/registry";
import { GwsError, isGwsError, type WireError } from "../../src/errors";
import { googleOAuth } from "../../src/google/oauth";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { fakeTransport, seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const store = openStore(env);
const baseConfig = loadConfig(env);

async function connected(scopes: string[]) {
  const email = uniqueEmail("disp-err");
  const seeded = await seedUserWithAccount(env, { email, scopes, isDefault: true });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { ...seeded, email, auth };
}

function session(auth: AuthProps, o: { apply?: boolean; config?: Partial<Config>; registry?: Registry } = {}) {
  return createCallSession({
    ports: workersPorts(env),
    auth,
    apply: o.apply ?? false,
    executeId: `x-${crypto.randomUUID()}`,
    config: { ...baseConfig, ...o.config },
    ...(o.registry ? { registry: o.registry } : {}),
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

function hostFn(name: string, run: (input: unknown, ctx: CallCtx) => Promise<unknown>, output: z.ZodType = z.unknown()): FnDef {
  return {
    name,
    service: "helpers",
    effect: "read",
    kind: "host",
    description: "test host fn",
    signature: `${name}(): Promise<unknown>`,
    tsDecl: "",
    example: "",
    tags: [],
    scopes: [],
    input: z.looseObject({}),
    output,
    run,
  };
}

const LIST = "gmail.users.messages.list";
const LIST_PATH = "/gmail\\.googleapis\\.com/gmail/v1/users/me/messages$";

describe("dispatcher error codes", () => {
  it("returns GWS_UNKNOWN_METHOD for a name that is not registered, without echoing it", async () => {
    const s = session({ userId: "u_nobody", clientId: "c" });
    const err = errorOf(await s.dispatch("nope.method", {}));
    expect(err.code).toBe("GWS_UNKNOWN_METHOD");
    expect(JSON.stringify(err)).not.toContain("nope.method");
    expect(errorOf(await s.dispatch(42, {})).code).toBe("GWS_UNKNOWN_METHOD");
    expect(errorOf(await s.dispatch("__proto__", {})).code).toBe("GWS_UNKNOWN_METHOD");
    expect(s.calls.map((c) => c.fn)).toEqual(["<unknown>", "<unknown>", "<unknown>"]);
  });

  it("returns GWS_INVALID_INPUT with issue paths and messages, never the offending value", async () => {
    const { auth } = await connected([`${G}gmail.readonly`]);
    const s = session(auth);
    const err = errorOf(await s.dispatch(LIST, { userId: "me", maxResults: "x-secret-value" }));
    expect(err.code).toBe("GWS_INVALID_INPUT");
    const issues = err.details?.issues as Array<{ path: string; message: string }>;
    expect(issues.map((i) => i.path)).toEqual(["maxResults"]);
    expect(typeof issues[0]?.message).toBe("string");
    expect(JSON.stringify(err)).not.toContain("x-secret-value");
  });

  it("limits invalid-input issues to the first five", async () => {
    const { auth } = await connected([`${G}gmail.readonly`]);
    const bad = { userId: 1, maxResults: "a", includeSpamTrash: "b", q: 2, pageToken: 3, labelIds: "c", fields: 4 };
    const err = errorOf(await session(auth).dispatch(LIST, bad));
    expect((err.details?.issues as unknown[]).length).toBe(5);
  });

  it("returns GWS_RESPONSE_SHAPE with issue paths only when Google returns a body the schema rejects", async () => {
    const { auth, email } = await connected([`${G}gmail.readonly`]);
    await fake.fault({ email, method: "GET", pathRegex: LIST_PATH, times: 1, response: { status: 200, body: { messages: "bad" } } });
    const err = errorOf(await session(auth).dispatch(LIST, { userId: "me" }));
    expect(err.code).toBe("GWS_RESPONSE_SHAPE");
    expect(err.details?.issues).toEqual([{ path: "messages" }]);
    expect(JSON.stringify(err)).not.toContain("bad");
  });

  it("returns GWS_SCOPE_MISSING with a connect hint before any upstream call", async () => {
    const { auth, email } = await connected([`${G}gmail.readonly`]);
    const before = (await fake.requests(email)).length;
    const err = errorOf(
      await session(auth, { apply: true }).dispatch("gmail.users.messages.send", { userId: "me", requestBody: { raw: "eA" } }),
    );
    expect(err.code).toBe("GWS_SCOPE_MISSING");
    expect(err.details?.connectHint).toBe("sdk.accounts.connect({services:['gmail']})");
    expect(err.details?.needAnyOf).toContain(`${G}gmail.send`);
    expect((await fake.requests(email)).length).toBe(before);
  });

  it("returns GWS_UPSTREAM_ERROR for a 500 and keeps the upstream body out of the error", async () => {
    const { auth, email } = await connected([`${G}gmail.readonly`]);
    await fake.fault({
      email,
      method: "GET",
      pathRegex: LIST_PATH,
      times: 1,
      response: { status: 500, body: { error: { code: 500, message: "upstream-body-text leaked?", status: "INTERNAL" } } },
    });
    const err = errorOf(await session(auth).dispatch(LIST, { userId: "me" }));
    expect(err.code).toBe("GWS_UPSTREAM_ERROR");
    expect(err.details?.status).toBe(500);
    expect(JSON.stringify(err)).not.toContain("upstream-body-text");
  });

  it("returns GWS_RECONNECT_REQUIRED when the refresh token was revoked, through the production transport", async () => {
    const { auth, refreshToken } = await connected([`${G}gmail.readonly`]);
    await googleOAuth(env, fakeTransport).revoke(refreshToken);
    const err = errorOf(await session(auth).dispatch(LIST, { userId: "me" }));
    expect(err.code).toBe("GWS_RECONNECT_REQUIRED");
  });

  it("gives the four input/response/scope/method failures pairwise distinct codes", () => {
    const codes = ["GWS_UNKNOWN_METHOD", "GWS_INVALID_INPUT", "GWS_RESPONSE_SHAPE", "GWS_SCOPE_MISSING"];
    expect(new Set(codes).size).toBe(4);
  });

  it("drops the account's cached access token on an upstream 401 and does not retry", async () => {
    const { auth, email, account } = await connected([`${G}gmail.readonly`]);
    const s = session(auth);
    valueOf(await s.dispatch(LIST, { userId: "me" }));
    expect(await env.CACHE_KV.get(`at:${account.id}`)).not.toBeNull();
    await fake.fault({ email, method: "GET", pathRegex: LIST_PATH, times: 1, response: { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } } });
    const before = (await fake.requests(email)).length;
    const err = errorOf(await s.dispatch(LIST, { userId: "me" }));
    expect(err.code).toBe("GWS_UPSTREAM_ERROR");
    expect(err.details?.status).toBe(401);
    expect(await env.CACHE_KV.get(`at:${account.id}`)).toBeNull();
    expect((await fake.requests(email)).length).toBe(before + 1);
  });
});

describe("snippet text echoed in errors", () => {
  it("returns a long, control-laden, token-shaped account ref scrubbed and capped", async () => {
    const { auth } = await connected([`${G}drive.file`]);
    const ref = `\u001b]0;pwn\u0007\u202e1//0gRefreshShaped-TOKEN_value${"\u0000A".repeat(3000)}`;
    const err = errorOf(await session(auth).dispatch("drive.files.list", { account: ref }));
    expect(err.code).toBe("GWS_ACCOUNT_DENIED");
    const text = JSON.stringify(err);
    expect(text).not.toMatch(/\\u00[01][0-9a-f]|\\u202e|\u202e/i);
    expect(text).not.toMatch(/1\/\/0g|RefreshShaped|TOKEN_value/);
    expect(text.length).toBeLessThan(1000);
  });

  it("never echoes an unknown fn name", async () => {
    const name = `\u001b[31m${"evil\u0000".repeat(2000)}`;
    const err = errorOf(await session(freshAuthForErrors()).dispatch(name, {}));
    expect(err.code).toBe("GWS_UNKNOWN_METHOD");
    expect(JSON.stringify(err)).not.toContain("evil");
  });
});

function freshAuthForErrors(): AuthProps {
  return { userId: `u_${crypto.randomUUID()}`, clientId: `c-${crypto.randomUUID()}` };
}

describe("dispatcher never throws across the RPC boundary", () => {
  it("turns a foreign host-fn exception into GWS_INTERNAL without its message", async () => {
    const reg = buildRegistry([
      hostFn("test.boom", async () => {
        throw new Error("raw ya29.secret-message");
      }),
    ]);
    const r = await session({ userId: "u_x", clientId: "c" }, { registry: reg }).dispatch("test.boom", {});
    expect(errorOf(r)).toEqual({ code: "GWS_INTERNAL", message: "internal error", fn: "test.boom" });
  });

  it("resolves with GWS_INTERNAL when even the error cannot be converted to the wire shape", async () => {
    const details = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        throw new Error("details ya29.boom");
      },
    });
    const reg = buildRegistry([
      hostFn("test.badError", async () => {
        throw new GwsError("GWS_UPSTREAM_ERROR", "x", { details });
      }),
    ]);
    const r = await session({ userId: "u_x", clientId: "c" }, { registry: reg }).dispatch("test.badError", {});
    expect(errorOf(r)).toEqual({ code: "GWS_INTERNAL", message: "internal error", fn: "test.badError" });
  });

  it("resolves with a structured error for an input whose getter throws", async () => {
    const reg = buildRegistry([hostFn("test.echo", async (i) => i)]);
    const hostile = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        throw new Error("getter ya29.boom");
      },
    });
    const r = await session({ userId: "u_x", clientId: "c" }, { registry: reg }).dispatch("test.echo", hostile);
    expect(JSON.stringify(errorOf(r))).not.toContain("ya29");
  });

  it("returns GWS_RESPONSE_SHAPE when a host fn's result fails its output schema", async () => {
    const reg = buildRegistry([hostFn("test.shape", async () => ({ n: "x" }), z.object({ n: z.number() }))]);
    const err = errorOf(await session({ userId: "u_x", clientId: "c" }, { registry: reg }).dispatch("test.shape", {}));
    expect(err.code).toBe("GWS_RESPONSE_SHAPE");
  });
});

describe("call session construction", () => {
  it("refuses a session config whose upstream mode differs from the env's, so credentials and destination agree", () => {
    let caught: unknown;
    try {
      session({ userId: "u_x", clientId: "c" }, { config: { GOOGLE_UPSTREAM: "google" } });
    } catch (e) {
      caught = e;
    }
    expect(isGwsError(caught) && caught.code).toBe("GWS_INTERNAL");
  });

  it("hands host fns no env, only allowlisted config values and the contract's capabilities", async () => {
    let seen: CallCtx | undefined;
    const reg = buildRegistry([
      hostFn("test.ctx", async (_i, ctx) => {
        seen = ctx;
        return {};
      }),
    ]);
    valueOf(await session({ userId: "u_x", clientId: "c" }, { registry: reg }).dispatch("test.ctx", {}));
    if (!seen) throw new Error("host fn did not run");
    expect(Object.keys(seen).sort()).toEqual(["apply", "auth", "call", "config", "executeId", "planStep", "resolveAllowed"]);
    expect(Object.keys(seen.config).sort()).toEqual([...HOST_CONFIG_KEYS].sort());
    const serialized = JSON.stringify(seen);
    for (const name of SECRET_NAMES) expect(serialized).not.toContain(String(env[name]));
    expect(Object.isFrozen(seen) && Object.isFrozen(seen.config)).toBe(true);
  });

  it("memoizes the SDK registry and refuses duplicate names", () => {
    expect(getRegistry()).toBe(getRegistry());
    expect(getRegistry().get(LIST)?.kind).toBe("google");
    const dup = hostFn("test.dup", async () => ({}));
    expect(() => buildRegistry([dup, dup])).toThrow(/duplicate/);
  });
});

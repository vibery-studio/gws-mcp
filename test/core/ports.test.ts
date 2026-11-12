import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig, type SecretName } from "../../src/config";
import type { AuditRow, AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { EXECUTE_MEMORY_BYTES, HOST_DEADLINE_GRACE_MS, runExecute, runSandbox } from "../../src/core/execute";
import type { Account, CorePorts, SandboxPort, SandboxRequest } from "../../src/core/ports";
import { GwsError, type WireError } from "../../src/errors";
import { workersPorts } from "../../src/runtime/workers/ports";
import { WORKERS_ISOLATE_MEMORY_BYTES, workersSandbox } from "../../src/runtime/workers/sandbox";

const baseConfig = loadConfig(env);
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const AUTH: AuthProps = { userId: "u_ports", clientId: "c_ports" };

const ACCOUNT: Account = {
  id: "a_ports",
  userId: AUTH.userId,
  email: "ports@example.test",
  sub: "sub-ports",
  isDefault: true,
  scopes: [DRIVE_FILE],
  status: "active",
  hasRefreshToken: true,
  tokenGeneration: "g1",
  createdAt: 1,
  updatedAt: 1,
};

/** In-memory ports, as another runtime would supply them: no env, no binding, no D1 or KV. */
function memoryPorts(o: { allowed?: boolean; upstream?: "google" | "fake"; sandbox?: SandboxPort } = {}) {
  const sent: Array<{ url: string; authorization: string | null }> = [];
  const audit: AuditRow[] = [];
  const counts = new Map<string, number>();
  const refuse = () => Promise.reject(new Error("not used by this test"));
  const ports: CorePorts = {
    sandbox: o.sandbox ?? { normalize: (c) => c, run: refuse },
    accounts: {
      resolve: async (userId, ref) => {
        if (userId !== ACCOUNT.userId || (ref !== undefined && ref !== ACCOUNT.email)) throw new GwsError("GWS_ACCOUNT_UNKNOWN", "no such account");
        return ACCOUNT;
      },
      listForUser: async () => [ACCOUNT],
      setAlias: refuse,
      setDefault: refuse,
      getRefreshTokenForRevoke: refuse,
      wipeToken: refuse,
    },
    approval: {
      isAllowed: async (userId, clientId, accountId) =>
        (o.allowed ?? true) && userId === AUTH.userId && clientId === AUTH.clientId && accountId === ACCOUNT.id,
      list: async () => ((o.allowed ?? true) ? [ACCOUNT.id] : []),
      remove: refuse,
    },
    tokens: { getAccessToken: async () => "access-token-from-port", invalidate: async () => undefined },
    links: { get: async () => null, put: refuse, delete: refuse },
    audit: { insertMany: async (rows) => void audit.push(...rows) },
    rate: {
      hit: async (key) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n;
      },
    },
    secrets: { get: () => undefined },
    http: {
      upstream: o.upstream ?? baseConfig.GOOGLE_UPSTREAM,
      send: async (url, init) => {
        sent.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({ files: [] });
      },
    },
    userSettings: { isSet: async () => false, get: async () => null, clear: refuse },
  };
  return { ports, sent, audit, counts };
}

function session(ports: CorePorts) {
  return createCallSession({ ports, auth: AUTH, apply: false, executeId: `x-${crypto.randomUUID()}`, config: baseConfig });
}

function errorOf(r: DispatchResult): WireError {
  if (!("__gwsError" in r)) throw new Error(`expected an error result, got ${JSON.stringify(r)}`);
  return r.__gwsError;
}

describe("the core over in-memory ports", () => {
  it("runs a Google read through the account store, allowlist, token cache, HTTP, rate counter and audit sink", async () => {
    const m = memoryPorts();
    const s = session(m.ports);
    expect(await s.dispatch("drive.files.list", {})).toEqual({ ok: true, value: { files: [] } });
    await s.close();
    expect(m.sent).toEqual([{ url: expect.stringMatching(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/), authorization: "Bearer access-token-from-port" }]);
    expect([...m.counts.keys()].sort()).toEqual([`c:${AUTH.userId}:${AUTH.clientId}`, `u:${AUTH.userId}`]);
    expect(m.audit).toHaveLength(1);
    expect(m.audit[0]).toMatchObject({ fn: "drive.files.list", account_id: ACCOUNT.id, status: "ok", applied: 0, upstream_status: 200 });
  });

  it("refuses an account the approval port does not allow, before any token or HTTP use", async () => {
    const m = memoryPorts({ allowed: false });
    const s = session(m.ports);
    expect(errorOf(await s.dispatch("drive.files.list", {}))).toMatchObject({ code: "GWS_ACCOUNT_DENIED" });
    await s.close();
    expect(m.sent).toEqual([]);
  });

  it("refuses ports whose upstream differs from the session config, so google credentials never reach the fake", () => {
    const other = baseConfig.GOOGLE_UPSTREAM === "fake" ? "google" : "fake";
    expect(() => session(memoryPorts({ upstream: other }).ports)).toThrow(
      expect.objectContaining({ code: "GWS_INTERNAL", message: "the session config and the env disagree on the Google upstream" }),
    );
  });

  it("hands the sandbox port the wrapped snippet, the prelude, a never-throwing call and every limit", async () => {
    const seen: SandboxRequest[] = [];
    const sandbox: SandboxPort = {
      normalize: (c) => c,
      run: async (req) => {
        seen.push(req);
        return { result: JSON.stringify(await req.call("no.such.fn", {})), logs: [] };
      },
    };
    const out = await runExecute({ code: "async () => 1", apply: false, auth: AUTH, ports: memoryPorts({ sandbox }).ports, config: baseConfig });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.limits).toEqual({ timeoutMs: baseConfig.EXECUTE_TIMEOUT_MS, cpuMs: 5000, memoryBytes: EXECUTE_MEMORY_BYTES });
    expect(seen[0]?.prelude).toContain("const sdk =");
    expect(seen[0]?.code).toContain("JSON.stringify(__gwsResult)");
    expect(out.result).toEqual({ __gwsError: expect.objectContaining({ code: "GWS_UNKNOWN_METHOD" }) });
  });

  it("stops waiting for a sandbox that never settles at the host deadline", async () => {
    const sandbox: SandboxPort = { normalize: (c) => c, run: () => new Promise(() => undefined) };
    const started = Date.now();
    const run = await runSandbox({ sandbox, timeoutMs: 100, cpuMs: 100, code: "async () => 1", call: async () => null });
    expect(run).toEqual({ status: "timed-out", limit: "wall", logs: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100 + HOST_DEADLINE_GRACE_MS - 5);
  });

  it("treats a sandbox's own GwsError as a host failure, never as a snippet outcome", async () => {
    const sandbox: SandboxPort = {
      normalize: (c) => c,
      run: async () => {
        throw new GwsError("GWS_INTERNAL", "refused by the runtime");
      },
    };
    const out = await runExecute({ code: "async () => 1", apply: false, auth: AUTH, ports: memoryPorts({ sandbox }).ports, config: baseConfig });
    expect(out.error).toEqual({ code: "GWS_INTERNAL", message: "refused by the runtime" });
  });
});

describe("the Workers adapters", () => {
  it("expose exactly the port methods, never the store's other methods or a binding", () => {
    const ports = workersPorts(env);
    expect(Object.keys(ports).sort()).toEqual(["accounts", "approval", "audit", "http", "links", "rate", "sandbox", "secrets", "tokens", "userSettings"]);
    // Snippets can never set a value, so the core's port has no setter.
    expect(Object.keys(ports.userSettings).sort()).toEqual(["clear", "get", "isSet"]);
    expect(Object.keys(ports.accounts).sort()).toEqual(["getRefreshTokenForRevoke", "listForUser", "resolve", "setAlias", "setDefault", "wipeToken"]);
    expect(Object.keys(ports.approval).sort()).toEqual(["isAllowed", "list", "remove"]);
    expect(Object.keys(ports.links).sort()).toEqual(["delete", "get", "put"]);
    const bindings = new Set<unknown>([env.DB, env.CACHE_KV, env.OAUTH_KV, env.FAKE_GOOGLE, env.LOADER, env.TOKEN_ENC_KEY, env.GOOGLE_CLIENT_SECRET]);
    for (const port of Object.values(ports)) {
      for (const v of Object.values(port as object)) expect(bindings.has(v)).toBe(false);
    }
  });

  it("read a secret only when the core asks for it", () => {
    const reads: string[] = [];
    const bindings = Object.defineProperty({ ...env }, "GOOGLE_CLIENT_SECRET", {
      get: () => {
        reads.push("GOOGLE_CLIENT_SECRET");
        return "lazily-read-secret";
      },
    });
    const ports = workersPorts(bindings);
    expect(reads).toEqual([]);
    expect(ports.secrets.get("GOOGLE_CLIENT_SECRET")).toBe("lazily-read-secret");
    expect(reads).toEqual(["GOOGLE_CLIENT_SECRET"]);
  });

  it("return secrets only, never another binding asked for by name", () => {
    const { secrets } = workersPorts(env);
    expect(secrets.get("TOKEN_ENC_KEY")).toBe(env.TOKEN_ENC_KEY);
    expect(secrets.get("GOOGLE_CLIENT_SECRET")).toBe(env.GOOGLE_CLIENT_SECRET);
    for (const name of ["DB", "LOADER", "CACHE_KV", "OAUTH_KV", "FAKE_GOOGLE", "GOOGLE_UPSTREAM", "toString", "__proto__"]) {
      expect(secrets.get(name as SecretName), name).toBeUndefined();
    }
  });

  it("follow the env's upstream for the HTTP port", () => {
    expect(workersPorts(env).http.upstream).toBe(loadConfig(env).GOOGLE_UPSTREAM);
  });

  it("refuse a sandbox memory limit below the Workers isolate limit instead of running with more", async () => {
    expect(EXECUTE_MEMORY_BYTES).toBeGreaterThanOrEqual(WORKERS_ISOLATE_MEMORY_BYTES);
    await expect(
      runSandbox({
        sandbox: workersSandbox(env.LOADER),
        timeoutMs: 5000,
        cpuMs: 1000,
        memoryBytes: WORKERS_ISOLATE_MEMORY_BYTES - 1,
        code: "async () => 1",
        call: async () => null,
      }),
    ).rejects.toMatchObject({ code: "GWS_INTERNAL" });
  });

  it("refuse a memory limit that is not a number, rather than run without one", async () => {
    for (const memoryBytes of [Number.NaN, Number.NEGATIVE_INFINITY]) {
      await expect(
        runSandbox({ sandbox: workersSandbox(env.LOADER), timeoutMs: 5000, cpuMs: 1000, memoryBytes, code: "async () => 1", call: async () => null }),
        String(memoryBytes),
      ).rejects.toMatchObject({ code: "GWS_INTERNAL" });
    }
  });
});

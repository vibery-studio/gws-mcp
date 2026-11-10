// Which structured error an execute reports when its snippet ends with an error. Shared by the Workers and the
// local runtime tests: the same cases run over each runtime's real sandbox and in-memory ports, so both report the
// error the snippet threw (or the first recorded one), never one the end of the execute caused.
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config";
import type { AuditRow, AuthProps } from "../../src/contracts";
import { runExecute, type ExecuteReport } from "../../src/core/execute";
import type { Account, CorePorts, SandboxPort } from "../../src/core/ports";
import { GwsError } from "../../src/errors";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const AUTH: AuthProps = { userId: "u_errors", clientId: "c_errors" };
const ACCOUNT: Account = {
  id: "a_errors",
  userId: AUTH.userId,
  email: "errors@example.test",
  sub: "sub-errors",
  isDefault: true,
  scopes: [DRIVE_FILE],
  status: "active",
  hasRefreshToken: true,
  tokenGeneration: "g1",
  createdAt: 1,
  updatedAt: 1,
};

/** In-memory ports over `sandbox`; every upstream answer waits `upstreamDelayMs`. */
export function memoryPorts(sandbox: SandboxPort, config: Config, upstreamDelayMs = 0): CorePorts {
  const refuse = () => Promise.reject(new Error("not used by this test"));
  const counts = new Map<string, number>();
  const audit: AuditRow[] = [];
  return {
    sandbox,
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
    approval: { isAllowed: async () => true, list: async () => [ACCOUNT.id], remove: refuse },
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
      upstream: config.GOOGLE_UPSTREAM,
      send: async () => {
        if (upstreamDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, upstreamDelayMs));
        return Response.json({ files: [] });
      },
    },
  };
}

export interface ExecuteErrorCasesOptions {
  /** The runtime's sandbox, as its ports supply it. */
  sandbox: () => SandboxPort;
  config: Config;
}

/** The cases every runtime must pass. */
export function executeErrorCases(runtime: string, o: ExecuteErrorCasesOptions): void {
  const exec = (code: string, config: Partial<Config> = {}, upstreamDelayMs = 0): Promise<ExecuteReport> => {
    const c = { ...o.config, ...config };
    return runExecute({ code, apply: false, auth: AUTH, ports: memoryPorts(o.sandbox(), c, upstreamDelayMs), config: c });
  };

  describe(`the error an execute reports (${runtime})`, () => {
    it("is the root error a Promise.all rejected with, not the error close() gave the calls still queued", async () => {
      // One upstream slot: the first call holds it (slowly), the second waits for it, the third is rate-limited at once.
      // The execute itself counts one hit, so a client limit of 3 refuses the third call.
      const out = await exec(
        `async () => {
          await Promise.all([sdk.drive.files.list({}), sdk.drive.files.list({}), sdk.drive.files.list({})]);
        }`,
        { UPSTREAM_CONCURRENCY: 1, RATE_CLIENT_PER_MIN: 3 },
        300,
      );
      expect(out.ok).toBe(false);
      expect(out.error).toMatchObject({ code: "GWS_RATE_LIMITED", details: { scope: "client", limit: 3 } });
      // The queued call was released by close: it is recorded with that error, which is not the execute's.
      expect(out.calls.map((c) => c.code ?? "ok").sort()).toEqual(["GWS_EXECUTION_ERROR", "GWS_RATE_LIMITED", "ok"]);
    });

    it("is the error the snippet threw, not the most recent one", async () => {
      const out = await exec(`async () => {
        const first = await sdk.no.such.fn({}).catch((e) => e);
        await sdk.drive.files.list({ pageSize: "many" }).catch((e) => e);
        throw first;
      }`);
      expect(out.error).toMatchObject({ code: "GWS_UNKNOWN_METHOD", fn: "<unknown>" });
      expect(out.calls.map((c) => c.code)).toEqual(["GWS_UNKNOWN_METHOD", "GWS_INVALID_INPUT"]);
    });

    it("is the first recorded error of the code a snippet rethrew with its own text", async () => {
      const out = await exec(`async () => {
        await sdk.no.such.fn({}).catch(() => undefined);
        await sdk.other.fn({}).catch(() => undefined);
        throw new Error("GWS_UNKNOWN_METHOD: rewritten by the snippet");
      }`);
      expect(out.error).toMatchObject({ code: "GWS_UNKNOWN_METHOD", message: "no SDK function has this name; use search to find one" });
    });

    it("is the recorded error with exactly the thrown text when two of the same code were returned", async () => {
      const out = await exec(`async () => {
        await sdk.drive.files.list({ pageSize: "many" }).catch(() => undefined);
        const second = await sdk.drive.files.get({ fileId: 7 }).catch((e) => e);
        throw second;
      }`);
      expect(out.calls.map((c) => c.code)).toEqual(["GWS_INVALID_INPUT", "GWS_INVALID_INPUT"]);
      expect(out.error).toMatchObject({ code: "GWS_INVALID_INPUT", message: "invalid input for drive.files.get", fn: "drive.files.get" });
    });

    it("is never an error the end of the execute gave calls still queued, even when the snippet names its code", async () => {
      // The first call holds the only upstream slot (slowly) and the second waits for it when the snippet throws its
      // own GWS_EXECUTION_ERROR text; close() then releases the waiting call with GWS_EXECUTION_ERROR too.
      const out = await exec(
        `async () => {
          sdk.drive.files.list({});
          sdk.drive.files.list({});
          await sdk.no.such.fn({}).catch(() => undefined);
          throw new Error("GWS_EXECUTION_ERROR: the snippet's own words");
        }`,
        { UPSTREAM_CONCURRENCY: 1 },
        300,
      );
      expect(out.calls.filter((c) => c.code === "GWS_EXECUTION_ERROR")).toHaveLength(1);
      expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: "GWS_EXECUTION_ERROR: the snippet's own words" });
    });

    it("is the snippet's own error when no call returned the code its text names", async () => {
      const out = await exec(`async () => { throw new Error("GWS_RATE_LIMITED: made up"); }`);
      expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: "GWS_RATE_LIMITED: made up" });
    });
  });
}

import { describe, expect, it } from "vitest";
import type { AuthProps } from "../../src/contracts";
import { runExecute, runSandbox } from "../../src/core/execute";
import type { SandboxPort } from "../../src/core/ports";
import { checkedRefusal, localSandbox, type LocalSandboxOptions } from "../../src/local/sandbox";
import { executeErrorCases, memoryPorts } from "../shared/execute-error-cases";
import { localConfig } from "./helpers";

const config = localConfig();
executeErrorCases("local QuickJS sandbox", { sandbox: () => localSandbox(), config });

const AUTH: AuthProps = { userId: "u_errors", clientId: "c_errors" };

function exec(code: string, opts: LocalSandboxOptions) {
  return runExecute({ code, apply: false, auth: AUTH, ports: memoryPorts(localSandbox(opts), config), config });
}

describe("a call the local sandbox refuses at its bridge", () => {
  it("is reported as GWS_INVALID_INPUT with its reason when the thread refused it", async () => {
    const out = await exec(`async () => { await sdk.drive.files.list({ q: "x".repeat(2000) }); }`, { callInputMaxBytes: 1000 });
    expect(out.error).toEqual({
      code: "GWS_INVALID_INPUT",
      message: "the input of one SDK call is larger than 1000 bytes",
      details: { reason: "input-too-large", max: 1000 },
    });
    expect(out.calls).toEqual([]);
  });

  it("is reported as GWS_INVALID_INPUT for a structure the thread refused", async () => {
    const out = await exec(`async () => {
      let deep = {};
      for (let i = 0; i < 100; i++) deep = { d: deep };
      await sdk.drive.files.list({ q: deep });
    }`, {});
    expect(out.error).toMatchObject({ code: "GWS_INVALID_INPUT", details: { reason: "input-too-complex" } });
  });

  it("is reported as GWS_INVALID_INPUT when the main thread refused it", async () => {
    const out = await exec(`async () => { await sdk.drive.files.list({ q: "x".repeat(2000) }); }`, {
      callInputMaxBytes: 1000,
      testHook: "skip-bridge-checks",
    });
    expect(out.error).toMatchObject({ code: "GWS_INVALID_INPUT", details: { reason: "input-too-large", max: 1000 } });
  });

  it("is not reported when the snippet caught it and ended with its own error", async () => {
    const out = await exec(`async () => {
      await sdk.drive.files.list({ q: "x".repeat(2000) }).catch(() => undefined);
      throw new Error("my own failure");
    }`, { callInputMaxBytes: 1000 });
    expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: "my own failure" });
  });
});

describe("refusals a sandbox reports", () => {
  it("are type-checked by the core: only known codes, bounded text and flat details pass", async () => {
    const valid = { code: "GWS_INVALID_INPUT", message: "too big", details: { reason: "input-too-large", max: 5, nested: { no: 1 } } };
    const sandbox: SandboxPort = {
      normalize: (c) => c,
      run: async () => ({
        error: "GWS_INVALID_INPUT: too big",
        refusals: [{ code: "GWS_NOT_A_CODE", message: "x" }, { code: "GWS_INTERNAL", message: "y".repeat(1001) }, "text", null, valid],
      }),
    };
    const run = await runSandbox({ sandbox, timeoutMs: 1000, cpuMs: 1000, code: "async () => 1", call: async () => null });
    expect(run).toMatchObject({ status: "threw", refusals: [{ code: "GWS_INVALID_INPUT", message: "too big", details: { reason: "input-too-large", max: 5 } }] });
    expect(run.status === "threw" ? run.refusals : undefined).toHaveLength(1);
  });

  it("are checked by the local sandbox before it passes them on: the bridge's own shape only", () => {
    const ok = { code: "GWS_INVALID_INPUT", message: "the input is too large", details: { reason: "input-too-large", max: 10 } };
    expect(checkedRefusal(ok)).toEqual(ok);
    expect(checkedRefusal({ ...ok, code: "GWS_INTERNAL" })).toBeUndefined();
    expect(checkedRefusal({ ...ok, message: "m".repeat(501) })).toBeUndefined();
    expect(checkedRefusal({ ...ok, details: { reason: "Not A Reason!", max: 10 } })).toBeUndefined();
    expect(checkedRefusal({ ...ok, details: { reason: "input-too-large", max: 1.5 } })).toBeUndefined();
    expect(checkedRefusal({ ...ok, details: { reason: "input-too-large", max: 10, extra: "x" } })).toEqual(ok);
    expect(checkedRefusal("GWS_INVALID_INPUT")).toBeUndefined();
  });
});

import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** The exact refusal workerd gives a worker that has no global outbound. */
const NO_INTERNET = /not permitted to access the internet/;
const FETCH_STATUS = 'async () => (await fetch("https://example.com/")).status';

describe("Worker Loader sandbox", () => {
  it("runs a snippet in a dynamic worker", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const out = await executor.execute("async () => 1 + 2", []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(3);
  });

  it("refuses network access from the snippet by default", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const out = await executor.execute(FETCH_STATUS, []);
    expect(out.error).toMatch(NO_INTERNET);
    expect(out.result).toBeUndefined();
  });

  it("lets the same fetch through when an outbound handler is configured", async () => {
    // Positive control: proves the refusal above comes from the missing outbound, not from DNS,
    // syntax or loader failures. The fake answers unknown paths with a Google-shaped 404.
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: env.FAKE_GOOGLE });
    const out = await executor.execute(FETCH_STATUS, []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(404);
  });

  it("gives the snippet no bindings through this.env", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const out = await executor.execute(
      'async () => { const e = this?.env; return e && typeof e === "object" ? Object.keys(e) : []; }',
      [],
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual([]);
  });

  it("gives the snippet an empty process.env", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const out = await executor.execute(
      'async () => typeof process === "undefined" ? "no-process" : Object.keys(process.env)',
      [],
    );
    expect(out.error).toBeUndefined();
    expect(out.result === "no-process" || (Array.isArray(out.result) && out.result.length === 0)).toBe(true);
  });

  it("gives the snippet no bindings through the cloudflare:workers env", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const out = await executor.execute(
      'async () => Object.keys((await import("cloudflare:workers")).env ?? {})',
      [],
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { runExecute, runSandbox, type SandboxCall } from "../../src/core/execute";
import { localPorts } from "../../src/local/ports";
import {
  localSandbox,
  MAX_CALL_INPUT_NODES,
  MAX_INPUT_DEPTH,
  RUN_INPUT_MULTIPLE,
  setMaxConcurrentSandboxes,
  type LocalSandboxOptions,
} from "../../src/local/sandbox";
import { LOCAL_USER_ID } from "../../src/local/store";
import { localConfig, openLocal, tempDir } from "./helpers";

const OK = (value: unknown) => ({ ok: true, value });

function run(code: string, o: LocalSandboxOptions & { call?: SandboxCall; timeoutMs?: number; cpuMs?: number } = {}) {
  const { call, timeoutMs, cpuMs, ...opts } = o;
  return runSandbox({
    sandbox: localSandbox(opts),
    code,
    call: call ?? (async () => OK(null)),
    timeoutMs: timeoutMs ?? 10_000,
    cpuMs: cpuMs ?? 5000,
    memoryBytes: 128 * 1024 * 1024,
  });
}

function returned(r: Awaited<ReturnType<typeof run>>): unknown {
  if (r.status !== "returned") throw new Error(`expected a return, got ${JSON.stringify(r)}`);
  return r.json === undefined ? undefined : JSON.parse(r.json);
}

/** The refusal reasons the snippet saw, in call order (null for a call the host answered). */
const REASONS = `(replies) => replies.map((r) => (r && r.__gwsError ? r.__gwsError.details.reason : null))`;

/** Watches the main thread while `work` runs: the longest gap between 10 ms ticks, and the peak heap growth. */
async function watched<T>(work: () => Promise<T>): Promise<{ value: T; maxGapMs: number; heapGrowth: number }> {
  const heap0 = process.memoryUsage().heapUsed;
  let last = Date.now();
  let maxGapMs = 0;
  let peak = heap0;
  const timer = setInterval(() => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 10);
  try {
    const value = await work();
    maxGapMs = Math.max(maxGapMs, Date.now() - last);
    return { value, maxGapMs, heapGrowth: peak - heap0 };
  } finally {
    clearInterval(timer);
  }
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

describe("host-side cost of what crosses the bridge", () => {
  it("ends the re-check probe (13 calls of ~1.6M objects through runExecute) with a structured error, the main thread ticking and the heap bounded", async () => {
    const t = tempDir();
    const l = await openLocal(t.dir);
    cleanups.push(t.cleanup, () => l.store.close());
    const config = localConfig({ EXECUTE_TIMEOUT_MS: 30_000 });
    const ports = localPorts({ config, store: l.store, secrets: l.secrets });
    const code = `async () => {
      const dataFilters = [];
      for (let i = 0; i < 1600000; i++) dataFilters.push({});
      for (let k = 0; k < 13; k++) {
        await sdk.sheets.spreadsheets.values.batchGetByDataFilter({ spreadsheetId: "s1", requestBody: { dataFilters } });
      }
    }`;
    const { value, maxGapMs, heapGrowth } = await watched(() =>
      runExecute({ code, apply: false, auth: { userId: LOCAL_USER_ID, clientId: "local" }, ports, config }),
    );
    // Refused in the thread before the dispatcher saw the call: the execute reports that refusal as its structured error.
    expect(value).toMatchObject({
      ok: false,
      error: {
        code: "GWS_INVALID_INPUT",
        message: expect.stringMatching(/^the input of one SDK call may hold at most 100000 JSON values/),
        details: { reason: "input-too-complex", max: MAX_CALL_INPUT_NODES },
      },
    });
    expect(value.calls).toEqual([]);
    expect(maxGapMs).toBeLessThan(1000);
    expect(heapGrowth).toBeLessThan(256 * 1024 * 1024);
  }, 60_000);

  it("sizes the per-call input cap from CALL_INPUT_MAX_BYTES, and the run budget at a fixed multiple of it", async () => {
    const seen: number[] = [];
    const call: SandboxCall = async (_name, input) => {
      seen.push(JSON.stringify(input).length);
      return OK(null);
    };
    const code = `async () => {
      const replies = [];
      replies.push(await __gws.call("a.b", { q: "x".repeat(1100) }));
      for (let i = 0; i < ${RUN_INPUT_MULTIPLE + 1}; i++) replies.push(await __gws.call("a.b", { q: "x".repeat(800) }));
      return (${REASONS})(replies);
    }`;
    const r = await run(code, { call, callInputMaxBytes: 1000 });
    // 1108 > 1000 is refused; 808-character calls pass until the run budget (multiple x 1000) is spent.
    const passing = Math.floor((RUN_INPUT_MULTIPLE * 1000) / 808);
    expect(returned(r)).toEqual([
      "input-too-large",
      ...Array.from({ length: passing }, () => null),
      ...Array.from({ length: RUN_INPUT_MULTIPLE + 1 - passing }, () => "run-input-budget"),
    ]);
    expect(seen).toEqual(Array.from({ length: passing }, () => 808));
  });

  it("takes the per-call cap from the active config through localPorts", async () => {
    const t = tempDir();
    const l = await openLocal(t.dir);
    cleanups.push(t.cleanup, () => l.store.close());
    const config = localConfig({ CALL_INPUT_MAX_BYTES: 1000 });
    const ports = localPorts({ config, store: l.store, secrets: l.secrets });
    const code = `async () => (await __gws.call("drive.files.list", { q: "x".repeat(1500) })).__gwsError.details.reason`;
    const out = await runExecute({ code, apply: false, auth: { userId: LOCAL_USER_ID, clientId: "local" }, ports, config });
    expect(out).toMatchObject({ ok: true, result: "input-too-large", calls: [] });
  });

  it("caps JSON nodes per call and per run, and nesting depth, counting structure only outside strings", async () => {
    let calls = 0;
    const call: SandboxCall = async () => {
      calls++;
      return OK(null);
    };
    const nodes = MAX_CALL_INPUT_NODES;
    const code = `async () => {
      const arrayOf = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(0); return a; };
      let deep = 0; for (let i = 0; i < ${MAX_INPUT_DEPTH + 1}; i++) deep = [deep];
      const replies = [];
      replies.push(await __gws.call("a.b", { v: arrayOf(${nodes}) }));
      replies.push(await __gws.call("a.b", { s: "[{,}]".repeat(200000) }));
      replies.push(await __gws.call("a.b", { deep }));
      for (let i = 0; i < ${RUN_INPUT_MULTIPLE + 1}; i++) replies.push(await __gws.call("a.b", { v: arrayOf(${Math.floor(nodes * 0.9)}) }));
      return (${REASONS})(replies);
    }`;
    const r = await run(code, { call, callInputMaxBytes: 5_000_000 });
    expect(returned(r)).toEqual([
      "input-too-complex",
      null,
      "input-too-complex",
      ...Array.from({ length: RUN_INPUT_MULTIPLE }, () => null),
      "input-too-complex",
    ]);
    expect(calls).toBe(1 + RUN_INPUT_MULTIPLE);
  });

  it("refuses an oversized message in the main thread before parsing it, even if the thread let it through", async () => {
    let calls = 0;
    const call: SandboxCall = async () => {
      calls++;
      return OK(null);
    };
    const r = await run(`async () => [(await __gws.call("a.b", { q: "x".repeat(5000) })).__gwsError.details.reason]`, {
      call,
      callInputMaxBytes: 1000,
      testHook: "skip-bridge-checks",
    });
    expect(returned(r)).toEqual(["input-too-large"]);
    expect(calls).toBe(0);
  });
});

describe("process-wide sandbox concurrency", () => {
  afterEach(() => setMaxConcurrentSandboxes(2));

  it("runs at most the configured number of sandboxes at once; extra runs wait in a queue", async () => {
    setMaxConcurrentSandboxes(2);
    let active = 0;
    let peak = 0;
    const call: SandboxCall = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 300));
      active--;
      return OK(null);
    };
    const t0 = Date.now();
    const results = await Promise.all([1, 2, 3, 4].map(() => run("async () => { await sdk.a.b({}); return 1; }", { call })));
    expect(results.map((r) => r.status)).toEqual(["returned", "returned", "returned", "returned"]);
    expect(peak).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
  });

  it("counts the wait in the queue against the deadline: a run whose deadline passes while queued never starts", async () => {
    setMaxConcurrentSandboxes(1);
    let started = 0;
    const slow: SandboxCall = async () => {
      started++;
      await new Promise((r) => setTimeout(r, 800));
      return OK(null);
    };
    const settled: number[] = [];
    const [first, second] = await Promise.all([
      run("async () => { await sdk.a.b({}); return 1; }", { call: slow, timeoutMs: 5000 }).then((r) => (settled.push(1), r)),
      run("async () => { await sdk.a.b({}); return 2; }", { call: slow, timeoutMs: 300 }).then((r) => (settled.push(2), r)),
    ]);
    expect(first.status).toBe("returned");
    expect(second).toEqual({ status: "timed-out", limit: "wall", logs: [] });
    // The first run holds the only slot for at least its 800 ms call, so the second ending first proves it left the
    // queue at its own deadline instead of waiting for the slot. Ordering, unlike elapsed time, does not depend on load.
    expect(settled).toEqual([2, 1]);
    // Long after the slot freed up, the timed-out run has still not started: it left the queue at its deadline.
    await new Promise((r) => setTimeout(r, 1500));
    expect(started).toBe(1);
  });

  it("refuses a concurrency outside 1..32", () => {
    for (const n of [0, -1, 33, 1.5, Number.NaN]) expect(() => setMaxConcurrentSandboxes(n)).toThrow("sandbox concurrency must be an integer from 1 to 32");
  });
});

describe("the sandbox thread's environment", () => {
  it("is empty: no variable of the parent process reaches the thread", async () => {
    process.env.GWS_MCP_ENV_SENTINEL = "parent-only-value";
    cleanups.push(() => delete process.env.GWS_MCP_ENV_SENTINEL);
    const r = await run("async () => 1", { testHook: "log-env" });
    expect(r.logs).toEqual(["env:[]"]);
  });
});

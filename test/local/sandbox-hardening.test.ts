import { afterEach, describe, expect, it, vi } from "vitest";
import { runExecute, runSandbox, type SandboxCall, type SandboxRun } from "../../src/core/execute";
import { localPorts } from "../../src/local/ports";
import { DEFAULT_CALL_INPUT_MAX_BYTES, localSandbox, MAX_LOG_LINES, MAX_MESSAGE_CHARS, RUN_INPUT_MULTIPLE, type RunEndInfo } from "../../src/local/sandbox";

const RUN_INPUT_BUDGET_CHARS = RUN_INPUT_MULTIPLE * DEFAULT_CALL_INPUT_MAX_BYTES;
import { LOCAL_USER_ID } from "../../src/local/store";
import { localConfig, openLocal, tempDir } from "./helpers";

const OK = (value: unknown) => ({ ok: true, value });

function run(code: string, o: { call?: SandboxCall; timeoutMs?: number; cpuMs?: number; memoryBytes?: number } = {}) {
  return runSandbox({
    sandbox: localSandbox(),
    code,
    call: o.call ?? (async () => OK(null)),
    timeoutMs: o.timeoutMs ?? 5000,
    cpuMs: o.cpuMs ?? 2000,
    memoryBytes: o.memoryBytes ?? 128 * 1024 * 1024,
  });
}

/** Counts timer ticks while `work` runs: a blocked event loop gives (almost) none. */
async function ticksDuring<T>(work: () => Promise<T>): Promise<{ value: T; ticks: number; ms: number }> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  try {
    const value = await work();
    return { value, ticks, ms: Date.now() - t0 };
  } finally {
    clearInterval(timer);
  }
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  vi.unstubAllGlobals();
});

describe("the sandbox deadline is preemptive (a worker thread per run)", () => {
  it("ends a native loop that never polls the interrupt (sparse lastIndexOf) at the deadline, with GWS_EXECUTION_TIMEOUT, and the event loop stays responsive", async () => {
    const t = tempDir();
    const l = await openLocal(t.dir);
    cleanups.push(t.cleanup, () => l.store.close());
    const config = localConfig({ EXECUTE_TIMEOUT_MS: 1000 });
    let threadEnded: (info: RunEndInfo) => void = () => undefined;
    const ended = new Promise<RunEndInfo>((resolve) => (threadEnded = resolve));
    const sandbox = localSandbox({ onRunEnd: (info) => threadEnded(info) });
    const ports = localPorts({ config, store: l.store, secrets: l.secrets, sandbox });
    const code = "async () => { const a = []; a.length = 2 ** 32 - 1; return a.lastIndexOf(1); }";
    const t0 = Date.now();
    const { value, ticks, ms } = await ticksDuring(() => runExecute({ code, apply: false, auth: { userId: LOCAL_USER_ID, clientId: "local" }, ports, config }));
    expect(value).toMatchObject({ ok: false, error: { code: "GWS_EXECUTION_TIMEOUT" } });
    expect(ms).toBeLessThan(1000 + 1500);
    // A concurrent 10 ms timer kept firing during the run: the main thread was never blocked.
    expect(ticks).toBeGreaterThan(30);
    // And the thread running the loop was terminated at the deadline, not left spinning in the background.
    const info = await Promise.race([ended, new Promise<"still running">((r) => setTimeout(() => r("still running"), 2500))]);
    expect(info).toEqual({ disposed: false, terminated: true });
    expect(Date.now() - t0).toBeLessThan(1000 + 2500);
  }, 20_000);

  it("keeps the event loop responsive during a synchronous busy loop too", async () => {
    const { value, ticks } = await ticksDuring(() => run("async () => { for (;;) {} }", { cpuMs: 600 }));
    expect(value).toMatchObject({ status: "timed-out", limit: "cpu" });
    expect(ticks).toBeGreaterThan(20);
  });
});

describe("call inputs crossing the bridge are capped before they are copied", () => {
  it("survives the 20 MB call loop with a structured error, holding at most the run's input budget", async () => {
    let received = 0;
    let calls = 0;
    const call: SandboxCall = async (_name, input) => {
      calls++;
      received += JSON.stringify(input).length;
      return OK(null);
    };
    const before = process.memoryUsage().rss;
    const r = await run("async () => { const big = 'x'.repeat(20 * 1024 * 1024); for (;;) __gws.call('drive.files.get', { q: big }); }", { call, cpuMs: 3000 });
    // Native string work between interrupt polls: the CPU budget or, preemptively, the wall deadline ends it.
    expect(r.status).toBe("timed-out");
    expect(received).toBeLessThanOrEqual(RUN_INPUT_BUDGET_CHARS);
    expect(calls).toBeLessThanOrEqual(Math.ceil(RUN_INPUT_BUDGET_CHARS / (20 * 1024 * 1024)));
    expect(process.memoryUsage().rss - before).toBeLessThan(1024 * 1024 * 1024);
  }, 30_000);

  it("refuses an over-long call name or input with GWS_INVALID_INPUT, without calling the host", async () => {
    const seen: unknown[] = [];
    const call: SandboxCall = async (name) => {
      seen.push(name);
      return OK(null);
    };
    const code = `async () => {
      const out = [];
      for (const [name, input] of [["n".repeat(300), {}], ["drive.files.get", { q: "y".repeat(33 * 1000 * 1000) }]]) {
        const res = await __gws.call(name, input);
        out.push(res.__gwsError.code + " " + res.__gwsError.details.reason);
      }
      return out;
    }`;
    const r = await run(code, { call });
    expect(r.status === "returned" && JSON.parse(r.json ?? "null")).toEqual(["GWS_INVALID_INPUT name-too-long", "GWS_INVALID_INPUT input-too-large"]);
    expect(seen).toEqual([]);
  });

  it("ends a flood of small calls with a limit, never a sandbox failure (the instance memory never grows)", async () => {
    const r = await run("async () => { for (;;) __gws.call('a.b', {}); }", { cpuMs: 1000 });
    expect(r).toMatchObject({ status: "timed-out", limit: "cpu" });
  });

  it("caps the calls in flight", async () => {
    let started = 0;
    const never: SandboxCall = () => {
      started++;
      return new Promise(() => undefined);
    };
    const code = `async () => {
      const replies = [];
      for (let i = 0; i < 600; i++) replies.push(__gws.call("a.b", {}));
      // The first 500 never settle; the rest are refused at once.
      return (await replies[599]).__gwsError.details.reason;
    }`;
    const r = await run(code, { call: never, timeoutMs: 3000 });
    expect(r.status === "returned" && JSON.parse(r.json ?? "null")).toBe("too-many-calls-in-flight");
    expect(started).toBeLessThanOrEqual(500);
  });
});

describe("other sandbox output bounds", () => {
  it("clips an error message before copying and redacting it", async () => {
    const r = await localSandbox().run({
      code: "async () => { throw new Error('m'.repeat(60 * 1024 * 1024)); }",
      prelude: "",
      call: async () => null,
      limits: { timeoutMs: 10_000, cpuMs: 5000, memoryBytes: 256 * 1024 * 1024 },
    });
    expect(typeof r.error).toBe("string");
    expect((r.error as string).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect((r.error as string).startsWith("mmmm")).toBe(true);
  }, 20_000);

  it("counts every log line, empty ones included, under a line cap", async () => {
    const r: SandboxRun = await run("async () => { for (;;) console.log(); }", { cpuMs: 1000 });
    expect(r.status).toBe("timed-out");
    expect(r.logs.length).toBeLessThanOrEqual(MAX_LOG_LINES + 1);
  });
});

describe("the end of a run", () => {
  it("never starts a call the snippet makes after the run returned", async () => {
    const seen: unknown[] = [];
    const call: SandboxCall = async (name, input) => {
      seen.push([name, input]);
      return OK(null);
    };
    const code =
      "async () => { Promise.resolve().then(() => 0).then(() => 0).then(() => 0).then(() => 0).then(() => __gws.call('gmail.users.messages.send', { late: true })); return 1; }";
    const r = await run(code, { call });
    expect(r).toMatchObject({ status: "returned", json: "1" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual([]);
  });

  it("drops the sandbox after a host function fails, without showing the host error to the snippet", async () => {
    const r = await runSandbox({
      sandbox: localSandbox({ testHook: "host-function-throws" }),
      code: "async () => { try { console.log('x'); } catch (e) { return 'caught: ' + e.message; } return 'not reached'; }",
      call: async () => null,
      timeoutMs: 5000,
      cpuMs: 2000,
      memoryBytes: 64 * 1024 * 1024,
    });
    expect(r).toEqual({ status: "threw", message: "the sandbox failed", logs: [] });
  });
});

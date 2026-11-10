import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { EXECUTE_MEMORY_BYTES, runSandbox, type SandboxCall, type SandboxRun } from "../../src/core/execute";
import type { SandboxRequest } from "../../src/core/ports";
import { SDK_PRELUDE } from "../../src/core/prelude";
import { isGwsError } from "../../src/errors";
import { MAX_OUTPUT_CHARS, localSandbox, normalizeSnippet, type RunEndInfo } from "../../src/local/sandbox";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OK = (value: unknown) => ({ ok: true, value });
const echo: SandboxCall = async (name, input) => OK({ name, input });

/** Runs a snippet through the core's wrapper (the same path as execute) over the local sandbox. */
function run(code: string, o: { call?: SandboxCall; timeoutMs?: number; cpuMs?: number; memoryBytes?: number; redact?: (t: string) => string } = {}) {
  const sandbox = localSandbox(o.redact ? { redact: o.redact } : {});
  return runSandbox({
    sandbox,
    code,
    call: o.call ?? echo,
    timeoutMs: o.timeoutMs ?? 5000,
    cpuMs: o.cpuMs ?? 2000,
    memoryBytes: o.memoryBytes ?? EXECUTE_MEMORY_BYTES,
  });
}

function returned(r: SandboxRun): unknown {
  if (r.status !== "returned") throw new Error(`expected a return, got ${JSON.stringify(r)}`);
  return r.json === undefined ? undefined : JSON.parse(r.json);
}

describe("the local QuickJS sandbox: results", () => {
  it("runs a snippet and returns its JSON result", async () => {
    expect(returned(await run("async () => ({ a: 1, b: [2, 'x'] })"))).toEqual({ a: 1, b: [2, "x"] });
    expect(returned(await run("1 + 2"))).toBe(3);
    expect(returned(await run("async () => {}"))).toBeUndefined();
  });

  it("calls the SDK through the host bridge, concurrently, with JSON in and out", async () => {
    const calls: Array<[unknown, unknown]> = [];
    const call: SandboxCall = async (name, input) => {
      calls.push([name, input]);
      await new Promise((r) => setTimeout(r, 5));
      return OK({ n: (input as { n: number }).n * 2 });
    };
    const r = await run("async () => Promise.all([1, 2, 3].map((n) => sdk.drive.files.get({ n })))", { call });
    expect(returned(r)).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }]);
    expect(calls).toEqual([
      ["drive.files.get", { n: 1 }],
      ["drive.files.get", { n: 2 }],
      ["drive.files.get", { n: 3 }],
    ]);
  });

  it("turns an SDK error envelope into a GwsError inside the snippet", async () => {
    const call: SandboxCall = async () => ({ __gwsError: { code: "GWS_ACCOUNT_DENIED", message: "no" } });
    const r = await run("async () => { try { await sdk.gmail.users.getProfile({}); } catch (e) { return [e.name, e.code, e.message]; } }", { call });
    expect(returned(r)).toEqual(["GwsError", "GWS_ACCOUNT_DENIED", "GWS_ACCOUNT_DENIED: no"]);
  });

  it("reports a thrown error, a syntax error and a non-JSON result as structured failures", async () => {
    expect(await run("async () => { throw new TypeError('bad thing'); }")).toMatchObject({ status: "threw", message: "bad thing" });
    expect(await run("async () => { throw 42; }")).toMatchObject({ status: "threw", message: "the snippet threw a number" });
    const syntax = await run("async () => { let = ; }");
    expect(syntax.status).toBe("threw");
    // The snippet can replace JSON.stringify in its own sandbox; the core accepts only text.
    expect(await run("async () => { JSON.stringify = () => 7; return 1; }")).toMatchObject({ status: "threw", message: "the snippet result is not JSON-serializable" });
  });

  it("captures console output in order, from every console method", async () => {
    const r = await run("async () => { console.log('a', 1, {b: 2}); console.warn('w'); console.error(new Error('e').message); console.info([1]); console.debug(null); }");
    expect(r.logs).toEqual(["a 1 {\"b\":2}", "w", "e", "[1]", "null"]);
  });
});

describe("the local QuickJS sandbox: escape probes", () => {
  it("exposes no host global: only the JavaScript built-ins, console and the sdk", async () => {
    const r = await run(`async () => {
      const names = ["fetch", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "require", "process", "module",
        "exports", "Buffer", "global", "importScripts", "WebAssembly", "Deno", "Bun", "navigator", "crypto", "XMLHttpRequest",
        "WebSocket", "hostCall", "hostLog", "hostDone", "hostFail", "__gwsHostCall", "std", "os", "scriptArgs", "print"];
      const found = {};
      for (const n of names) found[n] = typeof globalThis[n];
      return { found, sdk: typeof sdk, console: typeof console, gws: typeof __gws, keys: Object.keys(__gws),
        globals: Object.getOwnPropertyNames(globalThis).sort() };
    }`);
    const out = returned(r) as { found: Record<string, string>; sdk: string; console: string; gws: string; keys: string[]; globals: string[] };
    for (const [name, type] of Object.entries(out.found)) expect([name, type]).toEqual([name, "undefined"]);
    expect([out.sdk, out.console, out.gws, out.keys]).toEqual(["function", "object", "object", ["call"]]);
    const builtins = new Set(["globalThis", "console", "Object", "Function", "Array", "Number", "parseFloat", "parseInt", "Infinity", "NaN",
      "undefined", "Boolean", "String", "Symbol", "Date", "Promise", "RegExp", "Error", "AggregateError", "EvalError", "RangeError",
      "ReferenceError", "SyntaxError", "TypeError", "URIError", "InternalError", "JSON", "Math", "Reflect", "Proxy", "Map", "Set", "WeakMap",
      "WeakSet", "WeakRef", "FinalizationRegistry", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array",
      "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array", "Float16Array",
      "Float32Array", "Float64Array", "BigInt", "Iterator", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
      "escape", "unescape", "isFinite", "isNaN", "eval", "Atomics", "performance", "queueMicrotask"]);
    expect(out.globals.filter((g) => !builtins.has(g))).toEqual([]);
  });

  it("gives eval, the Function constructor and dynamic import nothing of the host", async () => {
    const r = await run(`async () => {
      const viaFunction = Function("return this")();
      const viaEval = (0, eval)("this");
      let imported;
      try { await import("node:fs"); imported = "loaded"; } catch (e) { imported = "refused"; }
      let required;
      try { required = typeof require("fs"); } catch (e) { required = "refused"; }
      return [viaFunction === globalThis, viaEval === globalThis, typeof viaFunction.process, eval("typeof process"),
        (() => {}).constructor("return typeof fetch")(), imported, required];
    }`);
    expect(returned(r)).toEqual([true, true, "undefined", "undefined", "undefined", "refused", "refused"]);
  });

  it("keeps prototype pollution inside the sandbox: host prototypes, call inputs and host replies are untouched", async () => {
    const hostReply = { list: [1], nested: { a: 1 } };
    const inputs: unknown[] = [];
    const call: SandboxCall = async (_name, input) => {
      inputs.push(input);
      return OK(hostReply);
    };
    const r = await run(
      `async () => {
        Object.prototype.polluted = "yes";
        Array.prototype.polluted = "yes";
        Object.prototype.toJSON = undefined;
        Object.defineProperty(Object.prototype, "__proto__", { get() { return null; } });
        const res = await sdk.drive.files.list({ q: "x" });
        res.nested.a = 2;
        res.list.push(9);
        res.constructor.prototype.injected = true;
        return [sdk.constructor === undefined, typeof sdk.then, typeof sdk.__proto__];
      }`,
      { call },
    );
    expect(returned(r)).toEqual([true, "undefined", "function"]);
    const plain: Record<string, unknown> = {};
    expect(plain.polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(plain.injected).toBeUndefined();
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(hostReply).toEqual({ list: [1], nested: { a: 1 } });
    // What the host received is fresh host JSON: a plain object with the host's own prototype, no added keys.
    expect(inputs).toEqual([{ q: "x" }]);
    expect(Object.getPrototypeOf(inputs[0])).toBe(Object.prototype);
    expect(Object.keys(inputs[0] as object)).toEqual(["q"]);
  });

  it("cannot replace console, the bridge or the result channel", async () => {
    const r = await run(`async () => {
      let replaced;
      try { globalThis.console = { log() {} }; replaced = "assigned"; } catch (e) { replaced = "refused"; }
      try { __gws.call = () => 1; } catch (e) {}
      Promise.prototype.then = function () { throw new Error("hijacked"); };
      console.log("still captured");
      return replaced;
    }`);
    expect(r.logs).toEqual(["still captured"]);
    expect(returned(r)).toBe("refused");
  });

  it("starts every run in a fresh sandbox: nothing a snippet leaves behind is seen by the next", async () => {
    await run("async () => { globalThis.leftover = 1; Object.prototype.leak = 2; }");
    expect(returned(await run("async () => [typeof leftover, typeof ({}).leak]"))).toEqual(["undefined", "undefined"]);
  });
});

describe("the local QuickJS sandbox: limits", () => {
  it("ends a synchronous busy loop at the CPU budget (the interrupt handler), as a timeout", async () => {
    const t0 = Date.now();
    const r = await run("async () => { for (;;) {} }", { cpuMs: 200, timeoutMs: 10_000 });
    expect(r).toEqual({ status: "timed-out", limit: "cpu", logs: [] });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("ends a busy loop that starts after an SDK call, and a catastrophic regex", async () => {
    expect(await run("async () => { await sdk.x.y({}); for (;;) {} }", { cpuMs: 200 })).toMatchObject({ status: "timed-out", limit: "cpu" });
    expect(await run("async () => /(a+)+b/.test('a'.repeat(40) + 'c')", { cpuMs: 200 })).toMatchObject({ status: "timed-out", limit: "cpu" });
  });

  it("ends a busy loop at the wall deadline when that comes first, and a snippet that never settles", async () => {
    expect(await run("async () => { for (;;) {} }", { cpuMs: 10_000, timeoutMs: 200 })).toMatchObject({ status: "timed-out", limit: "wall" });
    const never: SandboxCall = () => new Promise(() => undefined);
    expect(await run("async () => { console.log('waiting'); await sdk.a.b({}); }", { call: never, timeoutMs: 200 })).toEqual({
      status: "timed-out",
      limit: "wall",
      logs: ["waiting"],
    });
  });

  it("the interrupt cannot be caught by the snippet", async () => {
    const r = await run("async () => { for (;;) { try { for (;;) {} } catch (e) {} } }", { cpuMs: 200 });
    expect(r).toMatchObject({ status: "timed-out", limit: "cpu" });
  });

  it("answers memory exhaustion with a structured error, and the host stays bounded", async () => {
    const before = process.memoryUsage().rss;
    const r = await run("async () => { const a = []; for (;;) a.push('x'.repeat(65536) + a.length); }", { memoryBytes: 32 * 1024 * 1024 });
    expect(r).toEqual({ status: "threw", message: "the snippet ran out of memory (limit 33554432 bytes)", logs: [] });
    expect(process.memoryUsage().rss - before).toBeLessThan(512 * 1024 * 1024);
    // Over the limit but under the instance's memory backstop: refused by the QuickJS limit itself.
    const big = await run("async () => new Uint8Array(40 * 1024 * 1024).length", { memoryBytes: 32 * 1024 * 1024 });
    expect(big).toMatchObject({ status: "threw", message: "the snippet ran out of memory (limit 33554432 bytes)" });
    expect(returned(await run("async () => new Uint8Array(16 * 1024 * 1024).length", { memoryBytes: 32 * 1024 * 1024 }))).toBe(16 * 1024 * 1024);
  });

  it("answers memory exhaustion at the execute limit (128 MiB) with the same structured error", async () => {
    const r = await run("async () => { const a = []; for (let i = 0; ; i++) a.push({ i }); }", { cpuMs: 30_000, timeoutMs: 60_000 });
    // Either QuickJS's own error, or (when it cannot even allocate that) the null it throws instead.
    expect(r.status).toBe("threw");
    expect(r.status === "threw" && r.message).toMatch(
      new RegExp(`^(?:the snippet ran out of memory|the snippet threw a object; it may have run out of memory) \\(limit ${EXECUTE_MEMORY_BYTES} bytes\\)$`),
    );
  }, 90_000);

  it("answers stack exhaustion with a structured error, in interpreted and in native recursion", async () => {
    expect(await run("async () => { const f = (n) => f(n + 1) + 1; return f(0); }")).toMatchObject({
      status: "threw",
      message: "the snippet exceeded the stack limit",
    });
    const nested = "async () => { let o = {}; let c = o; for (let i = 0; i < 300000; i++) { c.a = {}; c = c.a; } return JSON.stringify(o).length; }";
    expect(await run(nested)).toMatchObject({ status: "threw", message: "the snippet exceeded the stack limit" });
    // A run after a host-level stack failure starts from a fresh instance and works.
    expect(returned(await run("async () => 'fine'"))).toBe("fine");
  });

  it("refuses limits it cannot enforce, as a host failure (never runs with a looser one)", async () => {
    const sandbox = localSandbox();
    const base: SandboxRequest = { code: "async () => 1", prelude: "", call: echo, limits: { timeoutMs: 1000, cpuMs: 1000, memoryBytes: 1 << 24 } };
    for (const limits of [
      { memoryBytes: Number.NaN },
      { memoryBytes: -1 },
      { memoryBytes: 2 ** 32 - 1 },
      { memoryBytes: Number.POSITIVE_INFINITY },
      { timeoutMs: Number.NaN },
      { cpuMs: 0 },
      { cpuMs: 1.5 },
    ]) {
      const err = await sandbox.run({ ...base, limits: { ...base.limits, ...limits } }).catch((e: unknown) => e);
      expect(isGwsError(err) && err.code === "GWS_INTERNAL" && err.message).toBe("the local sandbox cannot enforce these limits");
    }
  });

  it("bounds the log lines kept in host memory", async () => {
    const r = await run(`async () => { const line = "x".repeat(1000000); for (let i = 0; i < 12; i++) console.log(line); }`, { cpuMs: 5000 });
    // Each line counts its length plus one.
    const kept = Math.floor(MAX_OUTPUT_CHARS / 1_000_001);
    expect(r.logs).toHaveLength(kept + 1);
    expect(r.logs.at(-1)).toBe(`[logs truncated in the sandbox: ${12 - kept} more lines]`);
  });

  it("refuses a result larger than the host keeps, without copying it", async () => {
    const r = await run(`async () => "y".repeat(${MAX_OUTPUT_CHARS + 10})`);
    expect(r).toMatchObject({ status: "threw", message: "the snippet result is larger than RESULT_MAX_BYTES" });
  });
});

describe("the local QuickJS sandbox: lifecycle and redaction", () => {
  it("runs each snippet in its own thread, terminated after the run, with QuickJS disposed whenever the run ended inside the thread", async () => {
    const ends: RunEndInfo[] = [];
    let reportEnd: () => void = () => undefined;
    const sandbox = localSandbox({
      onRunEnd: (info) => {
        ends.push(info);
        reportEnd();
      },
    });
    const never: SandboxCall = () => new Promise(() => undefined);
    // The last run waits for its deadline. Time queued for a sandbox slot counts against it, so it is long enough
    // that the run always gets a thread even while an earlier test's thread is still being terminated.
    const cases: Array<[string, SandboxCall, Partial<SandboxRequest["limits"]>]> = [
      ["async () => 1", echo, {}],
      ["async () => { throw new Error('x'); }", echo, {}],
      ["async () => { for (;;) {} }", echo, { cpuMs: 100 }],
      ["async () => { const a = []; for (;;) a.push('z'.repeat(4096) + a.length); }", echo, { memoryBytes: 8 << 20 }],
      ["async () => { await sdk.a.b({}); }", never, { timeoutMs: 1000 }],
    ];
    for (const [code, call, limits] of cases) {
      const ended = new Promise<void>((resolve) => (reportEnd = resolve));
      await runSandbox({ sandbox, code, call, timeoutMs: limits.timeoutMs ?? 5000, cpuMs: limits.cpuMs ?? 2000, memoryBytes: limits.memoryBytes ?? 16 << 20 });
      // The host stops waiting HOST_DEADLINE_GRACE_MS after the deadline, while the adapter reports the end only once
      // `worker.terminate()` has finished, which under load can be later: so wait for this run's own end report.
      await ended;
    }
    expect(ends.map((e) => e.terminated)).toEqual(cases.map(() => true));
    // The last run was ended by the main thread at the deadline: its thread was terminated, not left to dispose.
    expect(ends.slice(0, 4).map((e) => e.disposed)).toEqual([true, true, true, true]);
  });

  it("drops a host reply that arrives after the run ended", async () => {
    let release: (() => void) | undefined;
    const late: SandboxCall = () => new Promise((resolve) => (release = () => resolve(OK(1))));
    const r = await run("async () => { await sdk.a.b({}); }", { call: late, timeoutMs: 100 });
    expect(r.status).toBe("timed-out");
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned(await run("async () => 'next'"))).toBe("next");
  });

  it("redacts console lines and error messages through the local redactor", async () => {
    const secret = "local-only-secret-value-123";
    const redact = (t: string) => t.split(secret).join("[REDACTED]");
    const call: SandboxCall = async () => OK({ leaked: secret });
    const r = await run(
      `async () => { const v = await sdk.a.b({}); console.log("value", v.leaked, "ya29.abcdefghijk"); throw new Error("failed with " + v.leaked); }`,
      { call, redact },
    );
    expect(r).toEqual({ status: "threw", message: "failed with [REDACTED]", logs: ["value [REDACTED] ya29.abcdefghijk"] });
  });
});

describe("snippet normalization", () => {
  /** @cloudflare/codemode's own normalizeCode, loaded from the chunk its Node-safe entries share. */
  async function codemodeNormalize(): Promise<(code: string) => string> {
    const dist = path.join(ROOT, "node_modules", "@cloudflare", "codemode", "dist");
    const entry = readFileSync(path.join(dist, "browser.js"), "utf8");
    const m = /import \{[^}]*\b(\w+) as normalizeCode\b[^}]*\} from "\.\/([\w.-]+\.js)"/.exec(entry);
    if (!m?.[1] || !m[2]) throw new Error("normalizeCode import not found in @cloudflare/codemode");
    expect(readdirSync(dist)).toContain(m[2]);
    const chunk = (await import(pathToFileURL(path.join(dist, m[2])).href)) as Record<string, unknown>;
    const fn = chunk[m[1]];
    if (typeof fn !== "function") throw new Error("normalizeCode is not a function");
    return fn as (code: string) => string;
  }

  it("matches @cloudflare/codemode's normalizeCode, so a snippet means the same in both runtimes", async () => {
    const reference = await codemodeNormalize();
    const corpus = [
      "",
      "   ",
      "async () => 1",
      "() => { return 2 }",
      "1 + 2",
      "const a = 1;\na + 1",
      "const a = await sdk.x.y({});\nreturn a;",
      "```js\nasync () => 3\n```",
      "```\nconst x = 1; x\n```",
      "export default async function () { return 4 }",
      "export default class { }",
      "export default async () => 5",
      "export default 6",
      "async function main() { return 7 }",
      "function () {",
      "let x = ;",
      "if (true) { 1 }",
      "for (const x of [1]) {}",
      "console.log(1)",
      "class A {}",
    ];
    for (const code of corpus) expect([code, normalizeSnippet(code)]).toEqual([code, reference(code)]);
  });
});

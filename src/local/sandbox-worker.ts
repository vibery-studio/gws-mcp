/**
 * The QuickJS sandbox, run inside a worker thread (one per execute; see sandbox.ts). The main thread terminates
 * the thread at the wall deadline, which also ends native loops that never poll the interrupt handler.
 *
 * This module imports only packages and types: Node runs it directly (TypeScript type stripping) in tests, and
 * the build bundles it as dist/sandbox-worker.js. Every limit comes from the main thread in `workerData`.
 */
import { parentPort, workerData } from "node:worker_threads";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";

/** Everything one run needs, from the main thread. */
export interface WorkerJob {
  kind: "gws-sandbox";
  code: string;
  prelude: string;
  limits: { timeoutMs: number; cpuMs: number; memoryBytes: number };
  caps: {
    stackBytes: number;
    wasmHeadroomBytes: number;
    outputChars: number;
    logLines: number;
    messageChars: number;
    callNameChars: number;
    callInputChars: number;
    runInputChars: number;
    callInputNodes: number;
    runInputNodes: number;
    inputDepth: number;
    callsInFlight: number;
  };
  /**
   * Test only. `host-function-throws`: a host function throws (a host error must poison the run).
   * `skip-bridge-checks`: calls are forwarded unchecked (the main thread must refuse them itself).
   * `log-env`: the thread logs the keys of its own environment.
   */
  testHook?: "host-function-throws" | "skip-bridge-checks" | "log-env";
}

export type WorkerOutcome =
  | { kind: "returned"; value: string | undefined | null }
  | { kind: "threw"; message: string }
  | { kind: "limit"; limit: "wall" | "cpu" };

/** Worker to main thread. `end` is sent once; nothing the worker sends after it is acted on. */
export type FromWorker =
  | { t: "call"; id: number; name: string; input: string }
  /** A call this thread refused before forwarding it; the snippet got the same error. */
  | { t: "refused"; error: BridgeRefusal }
  | { t: "log"; line: string }
  | { t: "end"; outcome: WorkerOutcome; droppedLogs: number }
  | { t: "disposed"; disposed: boolean };

/** Main thread to worker: the JSON reply of call `id`. */
export interface ToWorker {
  t: "reply";
  id: number;
  text: string;
}

const WASM_PAGE_BYTES = 64 * 1024;
const OUT_OF_MEMORY = /^out of memory$/;
const STACK_OVERFLOW = /^stack overflow$/;
/**
 * The core wrapper's text for a thrown non-Error value. QuickJS throws `null` when it cannot even allocate its
 * "out of memory" error, which ends up as this; it cannot be told apart from a snippet's own `throw null`.
 */
const NON_ERROR = /^the snippet threw a (?:object|undefined)$/;

/**
 * JSON value nodes and the nesting depth of a JSON text, counted outside strings: each `{`, `[` and `,` adds a node,
 * plus one for the top value. Stops counting as soon as either cap is passed.
 */
function jsonShape(text: string, maxNodes: number, maxDepth: number): { nodes: number; depth: number } {
  let nodes = 1;
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length && nodes <= maxNodes && deepest <= maxDepth; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      nodes++;
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (c === 0x7d || c === 0x5d) depth--;
    else if (c === 0x2c) nodes++;
  }
  return { nodes, depth: deepest };
}

/** The structured refusal of one bridge call; the main thread builds the same shape for its own checks. */
export interface BridgeRefusal {
  code: "GWS_INVALID_INPUT";
  message: string;
  details: { reason: string; max: number };
}

function refusal(reason: string, message: string, max: number): BridgeRefusal {
  return { code: "GWS_INVALID_INPUT", message, details: { reason, max } };
}

/**
 * Runs first, with the host functions as arguments; they are never globals, so nothing later can name them. It
 * captures every built-in it relies on before the snippet runs, defines a frozen, non-replaceable `console`, and
 * returns `__gws` (one method, `call`, JSON text in and out), `watch` (reports how the snippet's promise settles
 * through the captured `Promise.prototype.then`) and `clip` (a prefix of a string, cut inside the sandbox).
 */
const BOOT = String.raw`(function (hostCall, hostLog, hostDone, hostFail) {
  "use strict";
  const S = String, stringify = JSON.stringify, parse = JSON.parse, then = Promise.prototype.then;
  const call = Function.prototype.call.bind(then);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const format = (args) => {
    let line = "";
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let text;
      if (typeof a === "string") text = a;
      else {
        try { text = stringify(a); } catch (e) { text = undefined; }
        if (text === undefined) { try { text = S(a); } catch (e) { text = "[unprintable]"; } }
      }
      line = i === 0 ? text : line + " " + text;
    }
    return line;
  };
  const log = function () { hostLog(format(arguments)); };
  const console = Object.freeze({ log: log, info: log, warn: log, error: log, debug: log });
  Object.defineProperty(globalThis, "console", { value: console, writable: false, enumerable: false, configurable: false });
  const gws = Object.freeze({ call: (name, input) => call(hostCall(S(name), stringify(input)), (text) => parse(text)) });
  const watch = (p) => { call(p, (v) => { hostDone(v); }, (e) => { hostFail(e); }); };
  const clip = (s, n) => slice(s, 0, n);
  return [gws, watch, clip];
})`;

/** The prelude (it defines `sdk` over `__gws`) and the snippet, in one strict function scope. */
function snippetScript(prelude: string, code: string): string {
  return `(function (__gws) {\n"use strict";\n${prelude}\nreturn (\n${code}\n)();\n})`;
}

function post(message: FromWorker): void {
  parentPort?.postMessage(message);
}

async function runJob(job: WorkerJob): Promise<void> {
  const { limits, caps } = job;
  const wallEnd = Date.now() + limits.timeoutMs;
  let cpuUsed = 0;
  let sliceStart = 0;
  let stoppedBy: "wall" | "cpu" | undefined;
  /** Set once `end` was sent: late replies are dropped and the interpreter is not entered again. */
  let over = false;
  /** Set when the host failed while the interpreter ran: the instance is never entered or disposed again. */
  let poisoned = false;
  let disposed = false;
  let logLines = 0;
  let logChars = 0;
  let droppedLogs = 0;
  let inputChars = 0;
  let inputNodes = 0;
  let inFlight = 0;
  let nextId = 0;
  const pending = new Map<number, QuickJSDeferredPromise>();
  let runtime: QuickJSRuntime | undefined;
  let vm: QuickJSContext | undefined;

  // Created at its full (capped) size and never grown: quickjs-emscripten 0.32 reads typed-array views after FFI
  // calls that may grow the memory (executePendingJobs, newPromise), and a growth detaches those views. The pages
  // are committed lazily, only as they are used.
  const pages = Math.ceil((limits.memoryBytes + caps.wasmHeadroomBytes) / WASM_PAGE_BYTES);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });

  let outcome: WorkerOutcome;
  try {
    const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
    runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(caps.stackBytes);
    runtime.setInterruptHandler(() => {
      const t = Date.now();
      if (t >= wallEnd) stoppedBy = "wall";
      else if (cpuUsed + (t - sliceStart) > limits.cpuMs) stoppedBy = "cpu";
      return stoppedBy !== undefined;
    });
    const rt = runtime;
    const ctx = rt.newContext();
    vm = ctx;
    let clip: QuickJSHandle | undefined;

    outcome = await new Promise<WorkerOutcome>((settle) => {
      /** Ends the run once. A tripped limit wins over whatever the interrupted code reported on its way out. */
      const finish = (o: WorkerOutcome): undefined => {
        if (over) return undefined;
        over = true;
        const final: WorkerOutcome = stoppedBy !== undefined ? { kind: "limit", limit: stoppedBy } : o;
        // Sent now, before anything the snippet's remaining jobs might send: the main thread acts on nothing after it.
        post({ t: "end", outcome: final, droppedLogs });
        settle(final);
        return undefined;
      };

      const lengthOf = (h: QuickJSHandle): number => {
        const l = ctx.getProp(h, "length");
        try {
          return ctx.getNumber(l);
        } finally {
          l.dispose();
        }
      };

      /** A string handle's text, cut to `max` units inside the sandbox before it is copied out. */
      const clipped = (h: QuickJSHandle, max: number): string | undefined => {
        if (lengthOf(h) <= max) return ctx.getString(h);
        if (clip === undefined) return undefined;
        const n = ctx.newNumber(max);
        const cut = ctx.callFunction(clip, ctx.undefined, h, n);
        n.dispose();
        if (cut.error) {
          cut.error.dispose();
          return undefined;
        }
        try {
          return ctx.typeof(cut.value) === "string" ? ctx.getString(cut.value) : undefined;
        } finally {
          cut.value.dispose();
        }
      };

      /** A message for an error value of the snippet: its (clipped) `message`, or its text if a string. Never a stack. */
      const messageOf = (h: QuickJSHandle): string => {
        try {
          if (ctx.typeof(h) === "string") return clipped(h, caps.messageChars) ?? "the snippet failed";
          if (ctx.typeof(h) !== "object") return "the snippet failed";
          const m = ctx.getProp(h, "message");
          try {
            return ctx.typeof(m) === "string" ? (clipped(m, caps.messageChars) ?? "the snippet failed") : "the snippet failed";
          } finally {
            m.dispose();
          }
        } catch {
          return "the snippet failed";
        }
      };

      const failed = (message: string): WorkerOutcome => {
        if (OUT_OF_MEMORY.test(message)) return { kind: "threw", message: `the snippet ran out of memory (limit ${limits.memoryBytes} bytes)` };
        if (NON_ERROR.test(message)) {
          return { kind: "threw", message: `${message}; it may have run out of memory (limit ${limits.memoryBytes} bytes)` };
        }
        if (STACK_OVERFLOW.test(message)) return { kind: "threw", message: "the snippet exceeded the stack limit" };
        return { kind: "threw", message };
      };

      /** The host failed while the interpreter ran: drop the instance and end the run with a structured error. */
      const hostFailure = (e: unknown): WorkerOutcome => {
        poisoned = true;
        if (e instanceof RangeError) return { kind: "threw", message: "the snippet exceeded the stack limit" };
        return { kind: "threw", message: "the sandbox failed" };
      };

      /** Runs interpreter code with CPU accounting; afterwards a tripped limit ends the run. */
      const enter = <T>(fn: () => T): T | undefined => {
        if (over || poisoned) return undefined;
        sliceStart = Date.now();
        try {
          return fn();
        } catch (e) {
          finish(stoppedBy ? { kind: "limit", limit: stoppedBy } : hostFailure(e));
          return undefined;
        } finally {
          cpuUsed += Date.now() - sliceStart;
          if (stoppedBy) finish({ kind: "limit", limit: stoppedBy });
        }
      };

      /**
       * A host function body. Anything it throws would reach the snippet as an Error carrying the host's message;
       * instead the instance is poisoned, the run ends with "the sandbox failed", and the snippet gets undefined.
       */
      const guarded =
        (body: (...args: QuickJSHandle[]) => QuickJSHandle | undefined) =>
        (...args: QuickJSHandle[]): QuickJSHandle | undefined => {
          try {
            if (job.testHook === "host-function-throws") throw new TypeError("host-side detail that must not reach the snippet");
            return body(...args);
          } catch {
            poisoned = true;
            return finish({ kind: "threw", message: "the sandbox failed" });
          }
        };

      const pump = () =>
        enter(() => {
          const r = rt.executePendingJobs();
          if (r.error) {
            const message = stoppedBy ? "" : messageOf(r.error);
            r.error.dispose();
            if (!stoppedBy) finish(failed(message));
          }
        });

      const settleCall = (deferred: QuickJSDeferredPromise, text: string) =>
        enter(() => {
          const h = ctx.newString(text);
          try {
            deferred.resolve(h);
          } finally {
            h.dispose();
          }
        });

      parentPort?.on("message", (m: ToWorker) => {
        if (m?.t !== "reply" || over || poisoned) return;
        const deferred = pending.get(m.id);
        if (deferred === undefined) return;
        pending.delete(m.id);
        inFlight--;
        settleCall(deferred, typeof m.text === "string" ? m.text : "null");
        deferred.dispose();
        pump();
      });

      const hostCall = ctx.newFunction(
        "hostCall",
        guarded((nameH, inputH) => {
          const deferred = ctx.newPromise();
          // Every check reads lengths only; nothing is copied out of the sandbox before it passes.
          const refuse = (error: BridgeRefusal): QuickJSHandle => {
            // Told to the main thread first, so the core can report the refusal when the snippet ends with it.
            post({ t: "refused", error });
            const h = ctx.newString(JSON.stringify({ __gwsError: error }));
            deferred.resolve(h);
            h.dispose();
            return deferred.handle;
          };
          const forward = (name: string, input: string): QuickJSHandle => {
            inFlight++;
            const id = nextId++;
            pending.set(id, deferred);
            post({ t: "call", id, name, input });
            return deferred.handle;
          };
          if (job.testHook === "skip-bridge-checks") {
            const text = (h: QuickJSHandle | undefined) => (h !== undefined && ctx.typeof(h) === "string" ? ctx.getString(h) : "");
            return forward(text(nameH), text(inputH));
          }
          if (nameH === undefined || ctx.typeof(nameH) !== "string" || lengthOf(nameH) > caps.callNameChars) {
            return refuse(refusal("name-too-long", `an SDK function name is at most ${caps.callNameChars} characters`, caps.callNameChars));
          }
          const inputLength = inputH !== undefined && ctx.typeof(inputH) === "string" ? lengthOf(inputH) : 0;
          if (inputLength > caps.callInputChars) {
            return refuse(refusal("input-too-large", `the input of one SDK call is larger than ${caps.callInputChars} bytes`, caps.callInputChars));
          }
          if (inputChars + inputLength > caps.runInputChars) {
            return refuse(refusal("run-input-budget", `the SDK call inputs of this execute total more than ${caps.runInputChars} bytes`, caps.runInputChars));
          }
          if (inFlight >= caps.callsInFlight) {
            return refuse(refusal("too-many-calls-in-flight", `at most ${caps.callsInFlight} SDK calls may be pending at once`, caps.callsInFlight));
          }
          const input = inputLength > 0 && inputH !== undefined ? ctx.getString(inputH) : "";
          // Structure, counted here in the thread (which the deadline can stop): the host's parse and validation
          // cost follows the node count, which the length alone does not bound.
          const shape = jsonShape(input, caps.callInputNodes, caps.inputDepth);
          if (shape.nodes > caps.callInputNodes || shape.depth > caps.inputDepth || inputNodes + shape.nodes > caps.runInputNodes) {
            return refuse(
              refusal(
                "input-too-complex",
                `the input of one SDK call may hold at most ${caps.callInputNodes} JSON values nested ${caps.inputDepth} deep, and the calls of one execute ${caps.runInputNodes} values together`,
                caps.callInputNodes,
              ),
            );
          }
          inputChars += inputLength;
          inputNodes += shape.nodes;
          return forward(ctx.getString(nameH), input);
        }),
      );

      const hostLog = ctx.newFunction(
        "hostLog",
        guarded((lineH) => {
          if (lineH === undefined || ctx.typeof(lineH) !== "string") return undefined;
          const length = lengthOf(lineH);
          // Every line counts, an empty one too: one unit for the line itself, plus a cap on lines.
          if (droppedLogs > 0 || logLines >= caps.logLines || logChars + length + 1 > caps.outputChars) {
            droppedLogs++;
            return undefined;
          }
          logLines++;
          logChars += length + 1;
          post({ t: "log", line: ctx.getString(lineH) });
          return undefined;
        }),
      );

      const hostDone = ctx.newFunction(
        "hostDone",
        guarded((valueH) => {
          const type = valueH === undefined ? "undefined" : ctx.typeof(valueH);
          if (type === "undefined" || valueH === undefined) return finish({ kind: "returned", value: undefined });
          if (type !== "string") return finish({ kind: "returned", value: null });
          if (lengthOf(valueH) > caps.outputChars) return finish({ kind: "threw", message: "the snippet result is larger than RESULT_MAX_BYTES" });
          return finish({ kind: "returned", value: ctx.getString(valueH) });
        }),
      );

      const hostFail = ctx.newFunction(
        "hostFail",
        guarded((errorH) => finish(errorH === undefined ? failed("the snippet failed") : failed(messageOf(errorH)))),
      );

      /** The value of an interpreter call, or undefined after ending the run with the error it threw. */
      const must = (r: ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle | undefined => {
        if (!r.error) return r.value;
        const message = stoppedBy ? "" : messageOf(r.error);
        r.error.dispose();
        finish(stoppedBy ? { kind: "limit", limit: stoppedBy } : failed(message));
        return undefined;
      };

      enter(() => {
        const hostFns = [hostCall, hostLog, hostDone, hostFail];
        const boot = must(ctx.evalCode(BOOT, "boot.js", { type: "global", strict: true }));
        const booted = boot && must(ctx.callFunction(boot, ctx.undefined, ...hostFns));
        boot?.dispose();
        for (const fn of hostFns) fn.dispose();
        if (!booted) return;
        const gws = ctx.getProp(booted, 0);
        const watch = ctx.getProp(booted, 1);
        clip = ctx.getProp(booted, 2);
        booted.dispose();
        const snippet = must(ctx.evalCode(snippetScript(job.prelude, job.code), "snippet.js", { type: "global", strict: true }));
        const started = snippet && must(ctx.callFunction(snippet, ctx.undefined, gws));
        snippet?.dispose();
        gws.dispose();
        const watched = started && must(ctx.callFunction(watch, ctx.undefined, started));
        started?.dispose();
        watch.dispose();
        watched?.dispose();
      });
      pump();
    });

    // Clean disposal only when the instance is consistent; otherwise the main thread drops the whole thread.
    if (!poisoned) {
      try {
        clip?.dispose();
        for (const d of pending.values()) d.dispose();
        vm.dispose();
        runtime.dispose();
        disposed = true;
      } catch {
        // A context left mid-call by a limit can fail to free; terminating the thread releases it.
      }
    }
  } catch {
    outcome = { kind: "threw", message: "the sandbox failed" };
    if (!over) post({ t: "end", outcome, droppedLogs });
  }
  over = true;
  post({ t: "disposed", disposed });
}

const job = workerData as WorkerJob | undefined;
if (parentPort !== null && job?.kind === "gws-sandbox") {
  if (job.testHook === "log-env") post({ t: "log", line: `env:${JSON.stringify(Object.keys(process.env))}` });
  void runJob(job);
}

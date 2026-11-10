import { Worker } from "node:worker_threads";
import * as acorn from "acorn";
import type { SandboxLimits, SandboxPort, SandboxRequest, SandboxResult } from "../core/ports";
import { GwsError } from "../errors";
import type { BridgeRefusal, FromWorker, ToWorker, WorkerJob, WorkerOutcome } from "./sandbox-worker";

/**
 * Stack the snippet may use, in bytes of the QuickJS stack. Deep recursion ends with a "stack overflow" error;
 * recursion inside native code (JSON of a deeply nested value) can exhaust the thread's stack first, which also
 * ends the run with a structured error.
 */
export const SANDBOX_STACK_BYTES = 256 * 1024;
/**
 * Linear memory the WebAssembly instance may grow by beyond the snippet's memory limit (QuickJS's own data, the
 * C stack, allocator slack). The instance's memory has a hard maximum of the limit plus this.
 */
const WASM_HEADROOM_BYTES = 32 * 1024 * 1024;
/** The QuickJS build takes a 32-bit size: larger limits could wrap around to "unlimited", so they are refused. */
const MAX_MEMORY_BYTES = 2 ** 31;
/**
 * Snippet output kept, in UTF-16 units: the result text, and all log lines together (each line counts one more).
 * Twice the largest RESULT_MAX_BYTES config allows; the core then applies the configured caps.
 */
export const MAX_OUTPUT_CHARS = 8_000_000;
/** Log lines kept per run, empty ones included. */
export const MAX_LOG_LINES = 10_000;
/** An error message is cut to this many UTF-16 units inside the sandbox, before it is copied and redacted. */
export const MAX_MESSAGE_CHARS = 65_536;
/** Longest SDK function name accepted over the bridge. */
export const MAX_CALL_NAME_CHARS = 256;
/**
 * One call's JSON input, in UTF-16 units (never more than its UTF-8 bytes), when the caller does not pass the
 * config's CALL_INPUT_MAX_BYTES: that setting's default. `localPorts` passes the active config's value.
 */
export const DEFAULT_CALL_INPUT_MAX_BYTES = 5_000_000;
/** The largest CALL_INPUT_MAX_BYTES the config accepts. */
const CALL_INPUT_MAX_BYTES_CEILING = 32_000_000;
/**
 * The run's input budgets are this multiple of the per-call caps: all call inputs of one run together may hold at
 * most 2 x CALL_INPUT_MAX_BYTES characters and 2 x MAX_CALL_INPUT_NODES JSON nodes. Two full-size calls (an upload
 * and its metadata, say) fit; the host never parses more than that per execute.
 */
export const RUN_INPUT_MULTIPLE = 2;
/**
 * JSON value nodes in one call's input (containers, elements and members, counted from the JSON text in the
 * thread). The host's parse and validation cost follows the node count, not the length: `[{},{},…]` is 3 characters
 * per object.
 */
export const MAX_CALL_INPUT_NODES = 100_000;
/** Nesting depth of one call's JSON input. Google request bodies nest a few levels; 64 is far above that. */
export const MAX_INPUT_DEPTH = 64;
/** SDK calls sent to the host and not answered yet: CALLS_PER_EXECUTE's ceiling. */
export const MAX_CALLS_IN_FLIGHT = 500;
/**
 * The sandbox thread's own V8 limits: a backstop behind the caps above (the QuickJS memory is a separate
 * WebAssembly memory with its own maximum).
 */
const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 } as const;
/** How long the main thread waits, after the run ended, for the thread to report its clean disposal. */
const DISPOSAL_WAIT_MS = 500;

/** How one run's thread ended, for tests: whether QuickJS was disposed inside it, and that it was terminated. */
export interface RunEndInfo {
  disposed: boolean;
  terminated: boolean;
}

export interface LocalSandboxOptions {
  /** Applied to every console line and error message before they leave the sandbox adapter. */
  redact?: (text: string) => string;
  /** The active config's CALL_INPUT_MAX_BYTES; DEFAULT_CALL_INPUT_MAX_BYTES when omitted. */
  callInputMaxBytes?: number;
  /** Test seam: told how each run's thread ended. */
  onRunEnd?: (info: RunEndInfo) => void;
  /**
   * Test only. `host-function-throws`: a host function inside the thread throws. `skip-bridge-checks`: the thread
   * forwards calls unchecked (to prove the main thread's own checks). `log-env`: the thread logs its env's keys.
   */
  testHook?: WorkerJob["testHook"];
}

// ---- Process-wide concurrency ---------------------------------------------------------------------------

/**
 * Sandboxes running at once in this process. Each holds a thread, a WebAssembly memory of up to memoryBytes + 32 MiB
 * and up to 384 MB of thread heap, so the cost is per concurrent run; extra runs wait in a queue.
 */
let maxConcurrent = 2;
let running = 0;
const queue: Array<() => void> = [];

/** Sets how many sandboxes may run at once in this process (an integer from 1 to 32; 2 by default). */
export function setMaxConcurrentSandboxes(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new GwsError("GWS_INTERNAL", "sandbox concurrency must be an integer from 1 to 32");
  maxConcurrent = n;
  admitQueued();
}

function admitQueued(): void {
  while (running < maxConcurrent && queue.length > 0) {
    running++;
    queue.shift()?.();
  }
}

/** Waits for a slot until `deadline` (epoch ms). True with a slot held; false when the deadline came first. */
function acquireSlot(deadline: number): Promise<boolean> {
  if (running < maxConcurrent && queue.length === 0) {
    running++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const admit = () => {
      clearTimeout(expiry);
      resolve(true);
    };
    const expiry = setTimeout(() => {
      const i = queue.indexOf(admit);
      if (i >= 0) queue.splice(i, 1);
      resolve(false);
    }, Math.max(0, deadline - Date.now()));
    queue.push(admit);
  });
}

function releaseSlot(): void {
  running--;
  admitQueued();
}

const INTERNAL_REPLY = JSON.stringify({ __gwsError: { code: "GWS_INTERNAL", message: "internal error" } });

/** The structured refusal of one bridge call, the same shape the thread answers with. */
function refusal(reason: string, message: string, max: number): BridgeRefusal {
  return { code: "GWS_INVALID_INPUT", message, details: { reason, max } };
}

/** Refusals kept per run for the core (it considers at most this many). */
const MAX_REFUSALS = 16;
const REFUSAL_REASON = /^[a-z-]{1,40}$/;

/** A refusal the thread reported, checked: the shape `refusal` builds, with short text. Anything else is dropped. */
export function checkedRefusal(e: unknown): BridgeRefusal | undefined {
  if (e === null || typeof e !== "object") return undefined;
  const r = e as Record<string, unknown>;
  const d = r.details as Record<string, unknown> | null | undefined;
  if (r.code !== "GWS_INVALID_INPUT" || typeof r.message !== "string" || r.message.length > 500) return undefined;
  if (typeof d !== "object" || d === null || typeof d.reason !== "string" || !REFUSAL_REASON.test(d.reason) || !Number.isSafeInteger(d.max)) {
    return undefined;
  }
  return refusal(d.reason, r.message, d.max as number);
}

/** The worker module next to this one: `.ts` when run from source (Node strips the types), `.js` when bundled. */
const WORKER_URL = new URL(`./sandbox-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url);

// ---- Snippet normalization -----------------------------------------------------------------------------

/**
 * Same as `normalizeCode` of @cloudflare/codemode 0.5.6 (which cannot load in Node: its entry imports
 * `cloudflare:workers`), so a snippet means the same in both runtimes. test/local/sandbox.test.ts compares the two.
 */
function stripCodeFences(code: string): string {
  const match = code.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/);
  return match?.[1] ?? code;
}

export function normalizeSnippet(code: string): string {
  const trimmed = stripCodeFences(code.trim());
  if (!trimmed.trim()) return "async () => {}";
  const source = trimmed.trim();
  try {
    const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const [only] = ast.body;
    if (ast.body.length === 1 && only?.type === "ExpressionStatement" && only.expression.type === "ArrowFunctionExpression") {
      return source;
    }
    if (ast.body.length === 1 && only?.type === "ExportDefaultDeclaration") {
      const decl = only.declaration;
      const inner = source.slice(decl.start, decl.end);
      if (decl.type === "FunctionDeclaration" && !decl.id) return `async () => {\nreturn (${inner})();\n}`;
      if (decl.type === "ClassDeclaration" && !decl.id) return `async () => {\nreturn (${inner});\n}`;
      return normalizeSnippet(inner);
    }
    if (ast.body.length === 1 && only?.type === "FunctionDeclaration") {
      return `async () => {\n${source}\nreturn ${only.id?.name ?? "fn"}();\n}`;
    }
    const last = ast.body[ast.body.length - 1];
    if (last?.type === "ExpressionStatement") {
      return `async () => {\n${source.slice(0, last.start)}return (${source.slice(last.expression.start, last.expression.end)})\n}`;
    }
    return `async () => {\n${source}\n}`;
  } catch {
    return `async () => {\n${source}\n}`;
  }
}


// ---- Limits ---------------------------------------------------------------------------------------------

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Refuses limits this sandbox cannot enforce exactly (NaN, infinities, non-integers, too large). */
function checkLimits(limits: SandboxLimits): SandboxLimits {
  const bad = (["timeoutMs", "cpuMs", "memoryBytes"] as const).filter((k) => !positiveInteger(limits[k]));
  if (bad.length === 0 && limits.memoryBytes <= MAX_MEMORY_BYTES) return limits;
  throw new GwsError("GWS_INTERNAL", "the local sandbox cannot enforce these limits", {
    details: { limits: bad.length > 0 ? bad : ["memoryBytes"], maxMemoryBytes: MAX_MEMORY_BYTES },
  });
}


// ---- Running a snippet ----------------------------------------------------------------------------------

/**
 * The QuickJS sandbox for the local runtime. Each run gets its own worker thread, which builds a fresh WebAssembly
 * instance with a capped linear memory, one runtime and one context; the thread is terminated when the run ends.
 * At the wall deadline (`timeoutMs`) the main thread terminates it: that is preemptive, so even a native loop that
 * never polls QuickJS's interrupt handler ends there. The snippet's own work never runs on the main thread. What the
 * main thread does for a run is bounded by the bridge caps: it parses and validates at most RUN_INPUT_MULTIPLE x
 * CALL_INPUT_MAX_BYTES characters and RUN_INPUT_MULTIPLE x MAX_CALL_INPUT_NODES JSON nodes of call input, and keeps
 * capped logs and results. At most `setMaxConcurrentSandboxes` runs proceed at once; the rest queue, and the time
 * spent queued counts against `timeoutMs`.
 *
 * Inside there are only the JavaScript built-ins, `console` and the `sdk` the prelude builds over `__gws.call`:
 * no fetch, timers, module loader, `process` or host object. Strings are the only thing that crosses, by message
 * passing: the SDK call's name and JSON input out (lengths checked before any copy), its JSON reply and console
 * lines back. Secrets never enter the thread: redaction happens here.
 *
 * Limits: `memoryBytes` (QuickJS's allocator limit, plus the instance's memory maximum and the thread's V8 limits
 * as backstops), `SANDBOX_STACK_BYTES`, `cpuMs` of interpreter time (QuickJS's interrupt handler) and `timeoutMs`
 * of wall time (the interrupt handler, then termination).
 */
export function localSandbox(opts: LocalSandboxOptions = {}): SandboxPort {
  const redact = opts.redact ?? ((t: string) => t);
  const callInputChars = opts.callInputMaxBytes ?? DEFAULT_CALL_INPUT_MAX_BYTES;
  if (!Number.isSafeInteger(callInputChars) || callInputChars < 1 || callInputChars > CALL_INPUT_MAX_BYTES_CEILING) {
    throw new GwsError("GWS_INTERNAL", `the sandbox call input cap must be an integer from 1 to ${CALL_INPUT_MAX_BYTES_CEILING}`);
  }
  const runInputChars = RUN_INPUT_MULTIPLE * callInputChars;

  async function run(req: SandboxRequest): Promise<SandboxResult> {
    const limits = checkLimits(req.limits);
    const start = Date.now();
    if (!(await acquireSlot(start + limits.timeoutMs))) return { limit: "wall", logs: [] };
    try {
      // The time spent waiting for a slot counts against the deadline.
      const remainingMs = limits.timeoutMs - (Date.now() - start);
      if (remainingMs <= 0) return { limit: "wall", logs: [] };
      return await runInThread(req, { ...limits, timeoutMs: remainingMs });
    } finally {
      releaseSlot();
    }
  }

  async function runInThread(req: SandboxRequest, limits: SandboxLimits): Promise<SandboxResult> {
    const job: WorkerJob = {
      kind: "gws-sandbox",
      code: req.code,
      prelude: req.prelude,
      limits: { timeoutMs: limits.timeoutMs, cpuMs: limits.cpuMs, memoryBytes: limits.memoryBytes },
      caps: {
        stackBytes: SANDBOX_STACK_BYTES,
        wasmHeadroomBytes: WASM_HEADROOM_BYTES,
        outputChars: MAX_OUTPUT_CHARS,
        logLines: MAX_LOG_LINES,
        messageChars: MAX_MESSAGE_CHARS,
        callNameChars: MAX_CALL_NAME_CHARS,
        callInputChars,
        runInputChars,
        callInputNodes: MAX_CALL_INPUT_NODES,
        runInputNodes: RUN_INPUT_MULTIPLE * MAX_CALL_INPUT_NODES,
        inputDepth: MAX_INPUT_DEPTH,
        callsInFlight: MAX_CALLS_IN_FLIGHT,
      },
    };
    if (opts.testHook !== undefined) job.testHook = opts.testHook;

    let worker: Worker;
    try {
      // stdout and stderr are piped and discarded: nothing from the thread may reach the stdio MCP stream.
      // An empty env: no variable of this process (tokens, paths, anything) is visible in the thread.
      worker = new Worker(WORKER_URL, { workerData: job, env: {}, execArgv: [], resourceLimits: WORKER_RESOURCE_LIMITS, stdout: true, stderr: true });
    } catch (e) {
      throw new GwsError("GWS_INTERNAL", "the local sandbox could not start", { cause: e });
    }
    worker.stdout.resume();
    worker.stderr.resume();

    const logs: string[] = [];
    let logChars = 0;
    let droppedLogs = 0;
    let over = false;
    /** The main thread ended the run (deadline): there is no clean disposal to wait for. */
    let endedHere = false;
    let exited = false;
    let disposed = false;
    let inputChars = 0;
    let inFlight = 0;
    const refusals: BridgeRefusal[] = [];
    const noteRefusal = (r: BridgeRefusal | undefined) => {
      if (r !== undefined && refusals.length < MAX_REFUSALS) refusals.push(r);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reportDisposal: () => void = () => undefined;
    const disposal = new Promise<void>((resolve) => (reportDisposal = resolve));
    const exit = new Promise<void>((resolve) => worker.once("exit", () => resolve()));

    const reply = (id: number, text: string) => {
      if (over) return;
      const m: ToWorker = { t: "reply", id, text };
      worker.postMessage(m);
    };

    /** One SDK call from the thread, checked again here before it reaches the host. */
    const onCall = (id: unknown, name: unknown, input: unknown) => {
      // The authoritative guard: nothing the thread asks after the run ended reaches upstream.
      if (over || typeof id !== "number") return;
      if (typeof name !== "string" || typeof input !== "string") return reply(id, INTERNAL_REPLY);
      // Sizes are checked before anything is parsed; the thread has already checked them and the JSON structure.
      const refuse = (r: BridgeRefusal) => {
        noteRefusal(r);
        reply(id, JSON.stringify({ __gwsError: r }));
      };
      if (name.length > MAX_CALL_NAME_CHARS) return refuse(refusal("name-too-long", "the SDK function name is too long", MAX_CALL_NAME_CHARS));
      if (input.length > callInputChars) {
        return refuse(refusal("input-too-large", `the input of one SDK call is larger than ${callInputChars} bytes`, callInputChars));
      }
      if (inputChars + input.length > runInputChars) {
        return refuse(refusal("run-input-budget", `the SDK call inputs of this execute total more than ${runInputChars} bytes`, runInputChars));
      }
      if (inFlight >= MAX_CALLS_IN_FLIGHT) {
        return refuse(refusal("too-many-calls-in-flight", `at most ${MAX_CALLS_IN_FLIGHT} SDK calls may be pending at once`, MAX_CALLS_IN_FLIGHT));
      }
      inputChars += input.length;
      inFlight++;
      let parsed: unknown;
      try {
        parsed = input === "" ? undefined : JSON.parse(input);
      } catch {
        parsed = undefined;
      }
      Promise.resolve()
        .then(() => req.call(name, parsed))
        .then(
          (value) => {
            try {
              return JSON.stringify(value ?? null) ?? "null";
            } catch {
              return INTERNAL_REPLY;
            }
          },
          // The core's `call` never throws; anything else is answered like a host failure.
          () => INTERNAL_REPLY,
        )
        .then((text) => {
          inFlight--;
          reply(id, text);
        });
    };

    const onLog = (line: unknown) => {
      if (over || typeof line !== "string") return;
      if (droppedLogs > 0 || logs.length >= MAX_LOG_LINES || logChars + line.length + 1 > MAX_OUTPUT_CHARS) {
        droppedLogs++;
        return;
      }
      logChars += line.length + 1;
      logs.push(redact(line));
    };

    const outcome = await new Promise<WorkerOutcome>((settle) => {
      const finish = (o: WorkerOutcome) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        settle(o);
      };
      worker.on("message", (m: FromWorker) => {
        if (m === null || typeof m !== "object") return;
        if (m.t === "call") onCall(m.id, m.name, m.input);
        else if (m.t === "refused") {
          if (!over) noteRefusal(checkedRefusal(m.error));
        } else if (m.t === "log") onLog(m.line);
        else if (m.t === "end") {
          if (typeof m.droppedLogs === "number") droppedLogs += m.droppedLogs;
          finish(checkedOutcome(m.outcome));
        } else if (m.t === "disposed") {
          disposed = m.disposed === true;
          reportDisposal();
        }
      });
      worker.on("error", (e: Error & { code?: string }) => {
        finish(
          e.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? { kind: "threw", message: `the snippet ran out of memory (limit ${limits.memoryBytes} bytes)` }
            : { kind: "threw", message: "the sandbox failed" },
        );
      });
      void exit.then(() => {
        exited = true;
        reportDisposal();
        finish({ kind: "threw", message: "the sandbox failed" });
      });
      // Preemptive: terminating the thread ends whatever it runs, native loops included.
      timer = setTimeout(() => {
        endedHere = true;
        finish({ kind: "limit", limit: "wall" });
      }, limits.timeoutMs);
    });

    if (!endedHere) {
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([disposal, new Promise<void>((resolve) => (waited = setTimeout(resolve, DISPOSAL_WAIT_MS)))]);
      clearTimeout(waited);
    }
    if (!exited) await worker.terminate();
    opts.onRunEnd?.({ disposed, terminated: true });

    const out: SandboxResult = { logs: droppedLogs === 0 ? logs : [...logs, `[logs truncated in the sandbox: ${droppedLogs} more lines]`] };
    if (outcome.kind === "limit") out.limit = outcome.limit;
    else if (outcome.kind === "threw") {
      out.error = redact(outcome.message);
      if (refusals.length > 0) out.refusals = refusals;
    }
    else out.result = outcome.value;
    return out;
  }

  return { normalize: normalizeSnippet, run };
}

/** The thread's report, checked: anything malformed or over its cap is a sandbox failure. */
function checkedOutcome(o: unknown): WorkerOutcome {
  const failure: WorkerOutcome = { kind: "threw", message: "the sandbox failed" };
  if (o === null || typeof o !== "object") return failure;
  const r = o as Record<string, unknown>;
  if (r.kind === "limit" && (r.limit === "wall" || r.limit === "cpu")) return { kind: "limit", limit: r.limit };
  // The thread clips messages before copying them; a longer one means it did not.
  if (r.kind === "threw" && typeof r.message === "string" && r.message.length <= MAX_MESSAGE_CHARS) return { kind: "threw", message: r.message };
  if (r.kind === "returned" && (r.value === undefined || r.value === null || (typeof r.value === "string" && r.value.length <= MAX_OUTPUT_CHARS))) {
    return { kind: "returned", value: r.value };
  }
  return failure;
}

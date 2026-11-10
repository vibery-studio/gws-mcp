import { DynamicWorkerExecutor, normalizeCode, type ResolvedProvider } from "@cloudflare/codemode";
import type { SandboxPort, SandboxResult } from "../../core/ports";
import { GwsError } from "../../errors";

/** The executor's message when its in-sandbox timer wins the race against the snippet. */
const TIMED_OUT = "Execution timed out";
/** How the runtime words a child ended for exceeding its CPU limit. */
const CPU_EXCEEDED = /exceeded (?:its )?cpu|cpu time limit|exceeded resource limits/i;
/** Memory of a Workers isolate, the Worker Loader child included. The platform enforces it; it cannot be lowered. */
export const WORKERS_ISOLATE_MEMORY_BYTES = 128 * 1024 * 1024;

/**
 * The loader with a CPU limit added to every child it loads (the lower of an existing limit and `cpuMs`).
 * The executor does not expose the Worker Loader's `limits`, so it gets this loader instead.
 */
export function withCpuLimit(loader: WorkerLoader, cpuMs: number): WorkerLoader {
  const limited = (code: WorkerLoaderWorkerCode): WorkerLoaderWorkerCode => ({
    ...code,
    limits: { ...code.limits, cpuMs: Math.min(code.limits?.cpuMs ?? cpuMs, cpuMs) },
  });
  return {
    load: (code) => loader.load(limited(code)),
    get: (name, getCode) => loader.get(name, async () => limited(await getCode())),
  };
}

/**
 * The Workers sandbox: a fresh Dynamic Worker per run with no network (`globalOutbound: null`), no bindings,
 * no extra modules and a CPU limit. The only things passed in are the `__gws` RPC provider (its single fn is
 * the core's `call`) and the prelude. Text-valued bindings would appear in the child's `process.env`, so none
 * are ever passed. Memory is the platform's isolate limit; a lower request is refused, never run.
 */
export function workersSandbox(loader: WorkerLoader): SandboxPort {
  return {
    normalize: (code) => normalizeCode(code),
    run: async (req): Promise<SandboxResult> => {
      // Written so that NaN (or any non-number) is refused too: `NaN < limit` is false.
      if (!(req.limits.memoryBytes >= WORKERS_ISOLATE_MEMORY_BYTES)) {
        throw new GwsError("GWS_INTERNAL", "the Workers sandbox cannot enforce a memory limit below the isolate limit", {
          details: { memoryBytes: req.limits.memoryBytes, isolateBytes: WORKERS_ISOLATE_MEMORY_BYTES },
        });
      }
      const executor = new DynamicWorkerExecutor({
        loader: withCpuLimit(loader, req.limits.cpuMs),
        timeout: req.limits.timeoutMs,
        globalOutbound: null,
      });
      const provider: ResolvedProvider = { name: "__gws", fns: { call: req.call }, prelude: req.prelude };
      let out: { result: unknown; error?: unknown; logs?: unknown };
      try {
        out = await executor.execute(req.code, [provider]);
      } catch (e) {
        // The loader or the RPC to the child failed (a syntax error in the snippet, or the CPU limit, ends up here).
        const message = e instanceof Error && e.message ? e.message : "the sandbox failed";
        if (CPU_EXCEEDED.test(message)) return { limit: "cpu", logs: [] };
        return { error: message, logs: [] };
      }
      if (out.error === TIMED_OUT) return { limit: "wall", logs: out.logs };
      const result: SandboxResult = { result: out.result, logs: out.logs };
      if (out.error !== undefined) result.error = out.error;
      return result;
    },
  };
}

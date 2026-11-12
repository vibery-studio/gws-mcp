import type { SandboxPort } from "../../core/ports";
import { GwsError } from "../../errors";
import { localSandbox, setMaxConcurrentSandboxes } from "../../local/sandbox";

/**
 * Bundled in place of src/runtime/workers/sandbox.ts on the Node host (scripts/node-host-bundle.ts aliases it),
 * with the same exports, so src/runtime/workers/ports.ts runs unchanged. There is no Worker Loader on Node: a
 * snippet runs in the local worker-thread QuickJS sandbox, which enforces the request's CPU, wall and memory
 * limits itself. The host configures it once at boot (`configureNodeSandbox`), before serving any request.
 */

/** Kept for export parity with the Workers module; the Node sandbox enforces `limits.memoryBytes` as asked. */
export const WORKERS_ISOLATE_MEMORY_BYTES = 128 * 1024 * 1024;

let shared: SandboxPort | undefined;

/** Builds the process-wide sandbox: the config's per-call input cap, and how many snippets may run at once. */
export function configureNodeSandbox(opts: { callInputMaxBytes: number; concurrency: number }): void {
  setMaxConcurrentSandboxes(opts.concurrency);
  shared = localSandbox({ callInputMaxBytes: opts.callInputMaxBytes });
}

/** The Workers signature; the loader argument is ignored (the env has no LOADER on Node). */
export function workersSandbox(_loader: unknown): SandboxPort {
  if (shared === undefined) throw new GwsError("GWS_INTERNAL", "the Node sandbox is not configured");
  return shared;
}

export function withCpuLimit(): never {
  throw new Error("withCpuLimit needs a Worker Loader, which the Node host does not have");
}

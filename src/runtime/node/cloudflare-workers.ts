/**
 * Stand-in for the `cloudflare:workers` module on Node. The Node host's bundle resolves that specifier here
 * (scripts/node-host-bundle.ts), so the Worker entry and its dependencies load unchanged.
 *
 * - `env`: one live object. The host fills it (`setWorkerEnv`) before the Worker entry is imported, because
 *   src/index.ts validates config from it at module load, as workerd does with its module-level env.
 * - `WorkerEntrypoint`, `DurableObject`: base classes that dependencies import or test with `instanceof`
 *   (workers-oauth-provider checks `handler.prototype instanceof WorkerEntrypoint`). Nothing here runs RPC or
 *   Durable Objects; constructing a `DurableObject` on Node is a bug in the caller, so it throws.
 */

/** The process-wide env: what the Worker entry imports as `env` from the `cloudflare:workers` module. */
export const env: Record<string, unknown> = {};

/** Replaces the env's contents in place, so modules that already imported `env` see the new values. */
export function setWorkerEnv(values: Record<string, unknown>): void {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, values);
}

export abstract class WorkerEntrypoint<E = unknown, P = unknown> {
  protected readonly ctx: ExecutionContext<P>;
  protected readonly env: E;
  constructor(ctx: ExecutionContext<P>, workerEnv: E) {
    this.ctx = ctx;
    this.env = workerEnv;
  }
}

export abstract class DurableObject<E = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: E;
  constructor(ctx: unknown, workerEnv: E) {
    this.ctx = ctx;
    this.env = workerEnv;
    throw new Error("Durable Objects are not available on the Node host");
  }
}

export abstract class WorkflowEntrypoint {
  constructor() {
    throw new Error("Workflows are not available on the Node host");
  }
}

export abstract class RpcTarget {}

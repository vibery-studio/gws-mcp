import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import pkg from "../../../package.json";
import { setWorkerEnv } from "./cloudflare-workers";
import type { NodeHostConfig } from "./config";
import { nodeD1 } from "./d1";
import { openDatabase, sweepKv } from "./database";
import { createHttpFront, type Logger } from "./http";
import { nodeKv } from "./kv";
import { configureNodeSandbox } from "./workers-sandbox";

/**
 * The Node host for the unchanged Worker entry (src/index.ts): one SQLite file holding the D1 schema (the D1
 * migrations, tracked in `d1_migrations` as wrangler does) and both KV namespaces, the `cloudflare:workers` env, an
 * ExecutionContext per request, the local worker-thread sandbox, and the node:http front (http.ts).
 *
 * Runs only as the bundle scripts/node-host-bundle.ts builds, which resolves `cloudflare:workers` and the Workers
 * sandbox module to the Node stand-ins in this folder.
 */

/** How often expired KV entries are removed (reads already hide them). */
const KV_SWEEP_INTERVAL_MS = 60_000;

export interface NodeHost {
  /** The address the server listens on (not the public URL). */
  listening: { host: string; port: number };
  db: DatabaseSync;
  /** Migrations applied at this boot. */
  migrationsApplied: string[];
  /**
   * Stops accepting, lets in-flight requests and `waitUntil` work finish (up to the shutdown timeout), then closes
   * the database. Safe to call more than once.
   */
  close(): Promise<void>;
}

/** The FAKE_GOOGLE service binding: the transport sends `http://fake-google/<host>/<path>`; only the path is kept. */
function fakeGoogleBinding(origin: string) {
  return {
    fetch(input: string, init?: RequestInit): Promise<Response> {
      const u = new URL(input);
      return fetch(new URL(`${u.pathname}${u.search}`, origin), init);
    },
  };
}

/** The Workers ExecutionContext: `waitUntil` work is tracked (and awaited at shutdown); `props` is per request. */
function executionContext(pending: Set<Promise<unknown>>, log: Logger): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      const p = Promise.resolve(promise).catch((e: unknown) => log("error", "waitUntil task failed", { error: e instanceof Error ? e.message : String(e) }));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

function settleWithin(promises: Iterable<Promise<unknown>>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.allSettled([...promises]).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function startNodeHost(config: NodeHostConfig, log: Logger): Promise<NodeHost> {
  const { db, applied } = openDatabase(config.dbFile);
  try {
    const env: Record<string, unknown> = {
      ...config.vars,
      ...config.secrets,
      PUBLIC_BASE_URL: config.worker.PUBLIC_BASE_URL,
      DB: nodeD1(db),
      OAUTH_KV: nodeKv(db, "OAUTH_KV"),
      CACHE_KV: nodeKv(db, "CACHE_KV"),
    };
    if (config.fakeGoogleUrl !== undefined) env.FAKE_GOOGLE = fakeGoogleBinding(config.fakeGoogleUrl);
    setWorkerEnv(env);
    configureNodeSandbox({ callInputMaxBytes: config.worker.CALL_INPUT_MAX_BYTES, concurrency: config.sandboxConcurrency });

    // Imported only now: src/index.ts validates the config from the `cloudflare:workers` env at module load.
    const worker = (await import("../../index")).default as { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };

    const pending = new Set<Promise<unknown>>();
    const front = createHttpFront((request) => worker.fetch(request, env as unknown as Env, executionContext(pending, log)), {
      publicBaseUrl: config.worker.PUBLIC_BASE_URL,
      maxBodyBytes: config.maxBodyBytes,
      trustedProxies: config.trustedProxies,
      clientIpHeader: config.clientIpHeader,
      healthy: () => db.prepare("SELECT 1 AS ok").get() !== undefined,
      version: pkg.version,
      log,
    });

    await new Promise<void>((resolve, reject) => {
      front.server.once("error", reject);
      front.server.listen(config.port, config.listenHost, () => {
        front.server.off("error", reject);
        resolve();
      });
    });
    front.server.on("error", (e) => log("error", "server error", { error: e.message }));
    const { port } = front.server.address() as AddressInfo;

    const sweep = setInterval(() => {
      try {
        sweepKv(db);
      } catch (e) {
        log("warn", "KV sweep failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }, KV_SWEEP_INTERVAL_MS);
    sweep.unref();

    let closing: Promise<void> | undefined;
    return {
      listening: { host: config.listenHost, port },
      db,
      migrationsApplied: applied,
      close() {
        closing ??= (async () => {
          clearInterval(sweep);
          const started = Date.now();
          const { abandoned } = await front.drain(config.shutdownTimeoutMs);
          if (abandoned > 0) log("warn", "shutdown timeout: closed requests still in flight", { abandoned });
          await settleWithin(pending, Math.max(1000, config.shutdownTimeoutMs - (Date.now() - started)));
          db.close();
        })();
        return closing;
      },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}

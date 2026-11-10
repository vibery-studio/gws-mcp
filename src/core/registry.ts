import type { Effect, FnDef, MethodMeta } from "../contracts";
import { GwsError } from "../errors";
import { registry } from "../sdk/index";

/** SDK functions by dotted name. */
export type Registry = ReadonlyMap<string, FnDef>;

/** POST methods that only read (they take a query in the request body). Must match the SDK generator's list. */
export const POST_READS: ReadonlySet<string> = new Set([
  "calendar.freebusy.query",
  "sheets.spreadsheets.getByDataFilter",
  "sheets.spreadsheets.developerMetadata.search",
  "sheets.spreadsheets.values.batchGetByDataFilter",
]);

const ACCOUNTS_PREFIX = "accounts.";

/** The effect an HTTP method implies: GET reads, everything else writes, except the known read-only POSTs. */
function impliedEffect(meta: MethodMeta): Effect {
  return meta.httpMethod === "GET" || (meta.httpMethod === "POST" && POST_READS.has(meta.id)) ? "read" : "write";
}

/**
 * The write guard keys on `effect` and the destructive flag on `name`, so both must agree with the method
 * metadata the request is built from; and only host fns in the accounts namespace may receive the
 * accounts capability, so the namespace and the service must agree.
 */
function wellFormed(fn: FnDef): boolean {
  if ((fn.service === "accounts") !== fn.name.startsWith(ACCOUNTS_PREFIX)) return false;
  if (fn.kind === "host") return typeof fn.run === "function";
  const meta = fn.method;
  if (fn.kind !== "google" || meta === undefined || fn.run !== undefined || fn.service === "accounts") return false;
  return fn.name === meta.id && fn.effect === meta.effect && fn.effect === impliedEffect(meta);
}

/**
 * Indexes functions by name. Fails on a duplicate name or a definition that is inconsistent (see
 * `wellFormed`), so a broken SDK fails at startup instead of slipping past the write guard.
 */
export function buildRegistry(fns: readonly FnDef[]): Registry {
  const map = new Map<string, FnDef>();
  for (const fn of fns) {
    if (map.has(fn.name)) throw new GwsError("GWS_INTERNAL", `duplicate SDK function name: ${fn.name}`);
    if (!wellFormed(fn)) throw new GwsError("GWS_INTERNAL", `malformed SDK function definition: ${fn.name}`);
    map.set(fn.name, fn);
  }
  return map;
}

let memo: Registry | undefined;

/** The SDK registry (generated Google fns, helpers, accounts), built once per isolate. */
export function getRegistry(): Registry {
  memo ??= buildRegistry(registry());
  return memo;
}

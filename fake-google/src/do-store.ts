import { DurableObject } from "cloudflare:workers";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "../../src/config";
import { createFakeGoogle, type FakeGoogleHandler, type FakeGoogleOptions } from "./app";
import { NO_ACCOUNT } from "./control";
import { accountKey } from "./oauth";
import type { FakeStore, JsonValue } from "./store";

/**
 * The OAuth callbacks the fake redirects to when its config sets none: local `wrangler dev` only. A deployment lists
 * its own (production, the E2E Worker) in the `GWS_MCP_CALLBACKS` var, space-separated; the fake then redirects only
 * to those, byte for byte, as a real Google client registration would.
 */
export const DEFAULT_GWS_MCP_CALLBACKS: readonly string[] = ["http://localhost:8787/google/callback"];

/** The `GWS_MCP_CALLBACKS` var as a list; each entry must be an absolute http(s) URL in canonical form. */
export function callbacksFromEnv(value: unknown): readonly string[] {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return DEFAULT_GWS_MCP_CALLBACKS;
  const list = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
  const canonical = (u: string) => {
    try {
      const url = new URL(u);
      return (url.protocol === "https:" || url.protocol === "http:") && url.href === u && !url.hash && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  if (list.length === 0 || !list.every(canonical)) {
    throw new Error("fake Google: GWS_MCP_CALLBACKS must be space-separated absolute http(s) URLs in canonical form");
  }
  return list;
}

/** Secrets the deployed fake needs. Generated values are 32 random bytes, base64 (44 characters). */
const FAKE_SECRETS = ["FAKE_ADMIN_TOKEN", "FAKE_SIGNING_KEY", "FAKE_LOGIN_SECRET"] as const;
const MIN_SECRET_LENGTH = 32;

export interface FakeEnv {
  FAKE_STATE: DurableObjectNamespace<FakeState>;
  GWS_MCP_CALLBACKS?: string;
  FAKE_ADMIN_TOKEN: string;
  FAKE_SIGNING_KEY: string;
  FAKE_LOGIN_SECRET: string;
}

/**
 * The fake's options from its Worker env. Throws, naming only the missing or malformed secrets, when any is
 * absent: a deployed fake without an admin token would leave its seed/reset/fault routes open. A malformed
 * `GWS_MCP_CALLBACKS` throws too, naming only the var.
 */
export function fakeOptions(
  env: { readonly [K in (typeof FAKE_SECRETS)[number] | "GWS_MCP_CALLBACKS"]?: unknown },
): Omit<FakeGoogleOptions, "store"> {
  const bad = FAKE_SECRETS.filter((name) => {
    const v = env[name];
    return typeof v !== "string" || v.length < MIN_SECRET_LENGTH;
  });
  if (bad.length > 0) {
    throw new Error(`fake Google: missing or too short secret(s) ${bad.join(", ")}; run scripts/dev-secrets.ts or wrangler secret put`);
  }
  const value = (name: (typeof FAKE_SECRETS)[number]) => env[name] as string;
  return {
    signingKey: value("FAKE_SIGNING_KEY"),
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    adminToken: value("FAKE_ADMIN_TOKEN"),
    redirectUris: callbacksFromEnv(env.GWS_MCP_CALLBACKS),
    loginSecret: value("FAKE_LOGIN_SECRET"),
  };
}

// ---------- storage ----------

/** The most keys one batch call may name (Durable Object storage's limit for get/put/delete). */
export const MAX_BATCH_KEYS = 128;

/**
 * The key/value calls DoStore makes. `getMany`, `putMany` and `deleteMany` are given at most
 * MAX_BATCH_KEYS keys; `list` returns keys in order. Durable Object storage implements it directly.
 */
export interface KvBackend {
  getOne(key: string): Promise<unknown>;
  getMany(keys: string[]): Promise<Map<string, unknown>>;
  list(prefix: string, limit?: number): Promise<Map<string, unknown>>;
  putMany(entries: Record<string, unknown>): Promise<void>;
  deleteMany(keys: string[]): Promise<number>;
}

export function durableBackend(storage: DurableObjectStorage): KvBackend {
  return {
    getOne: (key) => storage.get(key),
    getMany: (keys) => storage.get(keys),
    list: (prefix, limit) => storage.list(limit === undefined ? { prefix } : { prefix, limit }),
    putMany: (entries) => storage.put(entries),
    deleteMany: (keys) => storage.delete(keys),
  };
}

export interface DoStoreOptions {
  /** JSON text per stored value; longer values are split. Durable Object values are limited to 2 MB. */
  chunkChars?: number;
  /** Largest value accepted, as JSON text; larger puts fail and store nothing. */
  maxValueChars?: number;
  /** Request log entries kept per account (and for unattributed requests); the oldest go first. */
  logCap?: number;
}

/** A value's header: its JSON inline, or the number of chunks holding it. */
type Header = { json: string } | { chunks: number };

const VALUE_PREFIX = "v:";
const CHUNK_PREFIX = "c:";
const LOG_PREFIX = "log:req:";
const LOG_KEY = /^log:req:([^:]+):(.+)$/;

const chunkKey = (key: string, i: number) => `${CHUNK_PREFIX}${key}#${i}`;

/** Longest string (value or key) kept in a request log entry. */
export const LOG_STRING_MAX_CHARS = 512;
/** Most JSON text one request log entry keeps, before its `truncated` flag. */
export const LOG_ENTRY_MAX_CHARS = 2048;

/**
 * A request log entry cut to its size bound: strings longer than LOG_STRING_MAX_CHARS are truncated, and
 * fields (in order) are kept while their JSON text fits LOG_ENTRY_MAX_CHARS. Anything cut adds
 * `truncated: true`. A public caller controls the logged path and query, so without this one entry could
 * hold a whole URL (about 16 KB).
 */
export function capLogEntry(value: JsonValue): JsonValue {
  let left = LOG_ENTRY_MAX_CHARS;
  let truncated = false;
  const str = (s: string): string | undefined => {
    let out = s.length > LOG_STRING_MAX_CHARS ? s.slice(0, LOG_STRING_MAX_CHARS) : s;
    let cost = JSON.stringify(out).length;
    // Every character costs at least one JSON character, so dropping `cost - left` characters is enough
    // unless escapes were dropped too; the length shrinks on every pass.
    while (cost > left && out.length > 0) {
      out = out.slice(0, Math.max(0, out.length - (cost - left)));
      cost = JSON.stringify(out).length;
    }
    if (cost > left) return undefined;
    if (out.length < s.length) truncated = true;
    left -= cost;
    return out;
  };
  const walk = (v: JsonValue): JsonValue | undefined => {
    if (typeof v === "string") return str(v);
    if (v === null || typeof v !== "object") {
      const cost = JSON.stringify(v).length;
      if (cost > left) return undefined;
      left -= cost;
      return v;
    }
    if (left < 2) return undefined;
    left -= 2; // brackets
    if (Array.isArray(v)) {
      const out: JsonValue[] = [];
      for (const item of v) {
        left -= 1; // separator
        const kept = left > 0 ? walk(item) : undefined;
        if (kept === undefined) {
          truncated = true;
          break;
        }
        out.push(kept);
      }
      return out;
    }
    const out: { [key: string]: JsonValue } = {};
    for (const [k, item] of Object.entries(v)) {
      left -= 2; // ":" and separator
      const key = left > 0 ? str(k) : undefined;
      const kept = key === undefined ? undefined : walk(item);
      if (key === undefined || kept === undefined) {
        truncated = true;
        break;
      }
      out[key] = kept;
    }
    return out;
  };
  const capped = walk(value);
  if (!truncated) return value;
  return typeof capped === "object" && capped !== null && !Array.isArray(capped) ? { ...capped, truncated: true } : { truncated: true };
}

function isHeader(v: unknown): v is Header {
  if (typeof v !== "object" || v === null) return false;
  return typeof (v as { json?: unknown }).json === "string" || Number.isInteger((v as { chunks?: unknown }).chunks);
}

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_BATCH_KEYS) out.push(items.slice(i, i + MAX_BATCH_KEYS));
  return out;
}

/**
 * FakeStore over Durable Object storage. Values are kept as JSON text (so reads and writes copy, like
 * MemoryStore); a value too large for one storage value is split into chunks. The request log is bounded:
 * every account keeps its newest `logCap` entries, and entries naming an account that was never seeded
 * (anyone can put any email in a login hint) go to the unattributed log, which is bounded the same way.
 * Each entry is size-capped too (capLogEntry).
 */
export class DoStore implements FakeStore {
  readonly #backend: KvBackend;
  readonly #chunkChars: number;
  readonly #maxValueChars: number;
  readonly #logCap: number;
  /** Known log sizes per owner; recounted from storage when unknown. */
  readonly #logCounts = new Map<string, number>();

  constructor(backend: KvBackend, opts: DoStoreOptions = {}) {
    this.#backend = backend;
    this.#chunkChars = opts.chunkChars ?? 256 * 1024;
    this.#maxValueChars = opts.maxValueChars ?? 16 * 1024 * 1024;
    this.#logCap = opts.logCap ?? 1000;
  }

  async #header(key: string): Promise<Header | undefined> {
    const h = await this.#backend.getOne(VALUE_PREFIX + key);
    return isHeader(h) ? h : undefined;
  }

  async #text(key: string, header: Header): Promise<string> {
    if ("json" in header) return header.json;
    const keys = Array.from({ length: header.chunks }, (_, i) => chunkKey(key, i));
    const parts: string[] = [];
    for (const batch of batches(keys)) {
      const got = await this.#backend.getMany(batch);
      for (const k of batch) {
        const part = got.get(k);
        if (typeof part !== "string") throw new Error("fake store: a value chunk is missing");
        parts.push(part);
      }
    }
    return parts.join("");
  }

  async #deleteChunks(key: string, from: number, to: number): Promise<void> {
    const keys = Array.from({ length: Math.max(0, to - from) }, (_, i) => chunkKey(key, from + i));
    for (const batch of batches(keys)) await this.#backend.deleteMany(batch);
  }

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    const header = await this.#header(key);
    return header === undefined ? undefined : (JSON.parse(await this.#text(key, header)) as T);
  }

  async put(key: string, value: JsonValue): Promise<void> {
    const log = LOG_KEY.exec(key);
    if (log) return this.#putLog(log[1] ?? NO_ACCOUNT, log[2] ?? "", value);
    await this.#write(key, value);
  }

  async #write(key: string, value: JsonValue): Promise<void> {
    const text = JSON.stringify(value);
    if (text.length > this.#maxValueChars) throw new Error("fake store: value too large");
    const old = await this.#header(key);
    const oldChunks = old !== undefined && "chunks" in old ? old.chunks : 0;
    if (text.length <= this.#chunkChars) {
      await this.#backend.putMany({ [VALUE_PREFIX + key]: { json: text } satisfies Header });
      await this.#deleteChunks(key, 0, oldChunks);
      return;
    }
    const chunks = Math.ceil(text.length / this.#chunkChars);
    const entries = Array.from({ length: chunks }, (_, i): [string, string] => [
      chunkKey(key, i),
      text.slice(i * this.#chunkChars, (i + 1) * this.#chunkChars),
    ]);
    for (const batch of batches(entries)) await this.#backend.putMany(Object.fromEntries(batch));
    // The header goes last: a reader never sees a header whose chunks are not all written.
    await this.#backend.putMany({ [VALUE_PREFIX + key]: { chunks } satisfies Header });
    await this.#deleteChunks(key, chunks, oldChunks);
  }

  async #putLog(owner: string, seq: string, value: JsonValue): Promise<void> {
    const seeded = owner === NO_ACCOUNT || (await this.#header(accountKey(owner))) !== undefined;
    const target = seeded ? owner : NO_ACCOUNT;
    const prefix = `${LOG_PREFIX}${target}:`;
    await this.#write(prefix + seq, capLogEntry(value));
    let count = this.#logCounts.get(target) ?? (await this.#backend.list(VALUE_PREFIX + prefix)).size - 1;
    count++;
    if (count > this.#logCap) {
      const oldest = [...(await this.#backend.list(VALUE_PREFIX + prefix, count - this.#logCap)).keys()];
      // Log entries are capped (capLogEntry) far below the chunk size, so never chunked: deleting the
      // headers deletes them.
      for (const batch of batches(oldest)) count -= await this.#backend.deleteMany(batch);
    }
    this.#logCounts.set(target, count);
  }

  async delete(key: string): Promise<boolean> {
    const header = await this.#header(key);
    if (header === undefined) return false;
    await this.#backend.deleteMany([VALUE_PREFIX + key]);
    if ("chunks" in header) await this.#deleteChunks(key, 0, header.chunks);
    const log = LOG_KEY.exec(key);
    if (log) this.#logCounts.delete(log[1] ?? NO_ACCOUNT);
    return true;
  }

  async list<T extends JsonValue = JsonValue>(prefix: string): Promise<Array<[string, T]>> {
    const out: Array<[string, T]> = [];
    for (const [storageKey, header] of await this.#backend.list(VALUE_PREFIX + prefix)) {
      if (!isHeader(header)) continue;
      const key = storageKey.slice(VALUE_PREFIX.length);
      out.push([key, JSON.parse(await this.#text(key, header)) as T]);
    }
    // Same order as MemoryStore (UTF-16 code units), whatever order the backend lists in.
    return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

/**
 * The deployed fake's state: one instance (`idFromName("fake")`) serving the whole fake Google over SQLite-backed
 * storage, so every request sees every earlier write (the "change is observable" checks rely on it).
 */
export class FakeState extends DurableObject<FakeEnv> {
  readonly #handle: FakeGoogleHandler;

  constructor(ctx: DurableObjectState, env: FakeEnv) {
    super(ctx, env);
    this.#handle = createFakeGoogle({ store: new DoStore(durableBackend(ctx.storage)), ...fakeOptions(env) });
  }

  override fetch(request: Request): Promise<Response> {
    return this.#handle(request);
  }
}

import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * A KV-compatible namespace over SQLite: `get` (text/json/arrayBuffer/stream), `getWithMetadata`, `put` with
 * `expiration`/`expirationTtl`/`metadata`, `delete` and `list` (prefix, limit, cursor, key metadata).
 *
 * KV's own limits are enforced so code that would fail on Workers fails here too: keys up to 512 bytes, values up
 * to 25 MiB, metadata up to 1024 bytes of JSON, an expiry at least 60 s ahead, at most 1000 keys per list page.
 * Expired entries are invisible at once and removed lazily (on read) or by `sweepExpiredKv`.
 *
 * Unlike KV this store is strongly consistent: a write is visible to the next read. Nothing in the app relies on
 * KV's eventual consistency. That does not make a get-then-delete atomic: requests interleave at every await, so a
 * record read, checked and then deleted or replaced (the provider's authorization code, for one) can be used by two
 * concurrent requests here as on Workers. The app's own one-time links are enforced in SQL (`used_links`).
 */

export const KV_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS node_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  metadata TEXT,
  expires_at INTEGER,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS node_kv_expires_at ON node_kv(expires_at) WHERE expires_at IS NOT NULL;
`;

const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024;
const MIN_TTL_S = 60;
const MAX_LIST_LIMIT = 1000;

type GetType = "text" | "json" | "arrayBuffer" | "stream";
type GetArg = GetType | { type?: GetType; cacheTtl?: number } | undefined;

interface Row {
  value: Uint8Array;
  metadata: string | null;
  expires_at: number | null;
}

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(s: string): number {
  return utf8.encode(s).byteLength;
}

function checkKey(key: string): void {
  if (typeof key !== "string" || key === "" || key === "." || key === "..") throw new TypeError("KV key must be a non-empty string other than . and ..");
  if (byteLength(key) > MAX_KEY_BYTES) throw new TypeError(`KV key longer than ${MAX_KEY_BYTES} bytes`);
}

function typeOf(arg: GetArg): GetType {
  const t = typeof arg === "string" ? arg : (arg?.type ?? "text");
  if (t !== "text" && t !== "json" && t !== "arrayBuffer" && t !== "stream") throw new TypeError(`unknown KV get type ${String(t)}`);
  return t;
}

function decode(value: Uint8Array, type: GetType): unknown {
  switch (type) {
    case "text":
      return decoder.decode(value);
    case "json":
      return JSON.parse(decoder.decode(value));
    case "arrayBuffer":
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    case "stream":
      return new Blob([value]).stream();
  }
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return utf8.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError("KV put takes a string, ArrayBuffer, ArrayBufferView or ReadableStream");
}

/** The absolute expiry in epoch milliseconds, or null; KV's own rules for `expiration` and `expirationTtl`. */
function expiresAt(opts: { expiration?: number; expirationTtl?: number } | undefined, now: number): number | null {
  if (opts?.expirationTtl !== undefined) {
    const ttl = Number(opts.expirationTtl);
    if (!Number.isFinite(ttl) || ttl < MIN_TTL_S) throw new TypeError(`KV expirationTtl must be at least ${MIN_TTL_S} seconds`);
    return now + Math.floor(ttl) * 1000;
  }
  if (opts?.expiration !== undefined) {
    const at = Number(opts.expiration);
    if (!Number.isFinite(at) || at * 1000 < now + MIN_TTL_S * 1000) throw new TypeError(`KV expiration must be at least ${MIN_TTL_S} seconds in the future`);
    return Math.floor(at) * 1000;
  }
  return null;
}

function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export class NodeKvNamespace {
  private readonly selectOne: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;
  private readonly removeExpired: StatementSync;
  private readonly listPage: StatementSync;

  constructor(
    db: DatabaseSync,
    private readonly namespace: string,
    private readonly now: () => number = Date.now,
  ) {
    this.selectOne = db.prepare("SELECT value, metadata, expires_at FROM node_kv WHERE namespace = ? AND key = ?");
    this.upsert = db.prepare(
      `INSERT INTO node_kv (namespace, key, value, metadata, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at`,
    );
    this.remove = db.prepare("DELETE FROM node_kv WHERE namespace = ? AND key = ?");
    // Conditional, so an entry another connection has just written again is never removed by a stale read.
    this.removeExpired = db.prepare("DELETE FROM node_kv WHERE namespace = ? AND key = ? AND expires_at IS NOT NULL AND expires_at <= ?");
    // Keys sort by their UTF-8 bytes (SQLite's BINARY collation), as KV lists them. `substr` compares characters,
    // so a prefix match is exact for any Unicode prefix.
    this.listPage = db.prepare(
      `SELECT key, metadata, expires_at FROM node_kv
       WHERE namespace = ? AND key > ? AND substr(key, 1, length(?)) = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY key LIMIT ?`,
    );
  }

  private live(key: string): Row | null {
    checkKey(key);
    const row = this.selectOne.get(this.namespace, key) as Row | undefined;
    if (row === undefined) return null;
    const now = this.now();
    if (row.expires_at !== null && row.expires_at <= now) {
      this.removeExpired.run(this.namespace, key, now);
      return null;
    }
    return row;
  }

  async get(key: string, arg?: GetArg): Promise<unknown> {
    if (Array.isArray(key)) throw new TypeError("bulk KV get is not available on the Node host");
    const type = typeOf(arg);
    const row = this.live(key);
    return row === null ? null : decode(row.value, type);
  }

  async getWithMetadata(key: string, arg?: GetArg): Promise<{ value: unknown; metadata: unknown; cacheStatus: null }> {
    const type = typeOf(arg);
    const row = this.live(key);
    if (row === null) return { value: null, metadata: null, cacheStatus: null };
    return { value: decode(row.value, type), metadata: row.metadata === null ? null : JSON.parse(row.metadata), cacheStatus: null };
  }

  async put(key: string, value: unknown, opts?: { expiration?: number; expirationTtl?: number; metadata?: unknown }): Promise<void> {
    checkKey(key);
    const bytes = await toBytes(value);
    if (bytes.byteLength > MAX_VALUE_BYTES) throw new TypeError(`KV value larger than ${MAX_VALUE_BYTES} bytes`);
    let metadata: string | null = null;
    if (opts?.metadata !== undefined && opts.metadata !== null) {
      metadata = JSON.stringify(opts.metadata);
      if (byteLength(metadata) > MAX_METADATA_BYTES) throw new TypeError(`KV metadata larger than ${MAX_METADATA_BYTES} bytes`);
    }
    this.upsert.run(this.namespace, key, bytes, metadata, expiresAt(opts, this.now()));
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    this.remove.run(this.namespace, key);
  }

  async list(opts?: { prefix?: string | null; limit?: number; cursor?: string | null }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
    cacheStatus: null;
  }> {
    const prefix = opts?.prefix ?? "";
    const limit = opts?.limit ?? MAX_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new TypeError(`KV list limit must be 1 to ${MAX_LIST_LIMIT}`);
    const after = opts?.cursor ? decodeCursor(opts.cursor) : "";
    // One extra row tells whether another page exists.
    const rows = this.listPage.all(this.namespace, after, prefix, prefix, this.now(), limit + 1) as Array<{
      key: string;
      metadata: string | null;
      expires_at: number | null;
    }>;
    const page = rows.slice(0, limit);
    const keys = page.map((r) => {
      const k: { name: string; expiration?: number; metadata?: unknown } = { name: r.key };
      if (r.expires_at !== null) k.expiration = Math.floor(r.expires_at / 1000);
      if (r.metadata !== null) k.metadata = JSON.parse(r.metadata);
      return k;
    });
    const last = page[page.length - 1];
    if (rows.length > limit && last !== undefined) return { keys, list_complete: false, cursor: encodeCursor(last.key), cacheStatus: null };
    return { keys, list_complete: true, cacheStatus: null };
  }
}

/** The KV binding for `namespace`, typed as the Worker's `KVNamespace` for the env. */
export function nodeKv(db: DatabaseSync, namespace: string, now?: () => number): KVNamespace {
  return new NodeKvNamespace(db, namespace, now) as unknown as KVNamespace;
}

/** Expired entries one sweep pass removes at most, so a pass never holds the write lock for long. */
export const KV_SWEEP_BATCH = 1000;

/** Deletes up to `limit` expired entries of every namespace; returns how many went. */
export function sweepExpiredKv(db: DatabaseSync, now: number = Date.now(), limit = KV_SWEEP_BATCH): number {
  const r = db
    .prepare(
      `DELETE FROM node_kv WHERE (namespace, key) IN
         (SELECT namespace, key FROM node_kv WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?)`,
    )
    .run(now, limit);
  return Number(r.changes);
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Key/value state of the fake. Values are JSON and copied on read and write, like Durable Object storage.
 * Resource keys follow `<svc>:<kind>:<email>:<id>` (see fixtures/README.md), so all state is scoped per account.
 */
export interface FakeStore {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  put(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Entries whose key starts with `prefix`, sorted by key. */
  list<T extends JsonValue = JsonValue>(prefix: string): Promise<Array<[string, T]>>;
}

export class MemoryStore implements FakeStore {
  readonly #data = new Map<string, string>();

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    const raw = this.#data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async put(key: string, value: JsonValue): Promise<void> {
    this.#data.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.#data.delete(key);
  }

  async list<T extends JsonValue = JsonValue>(prefix: string): Promise<Array<[string, T]>> {
    const out: Array<[string, T]> = [];
    for (const [k, raw] of this.#data) if (k.startsWith(prefix)) out.push([k, JSON.parse(raw) as T]);
    return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

/** Namespaces used by the fake itself; seed data may not write into them. */
export const RESERVED_NAMESPACES = new Set(["oauth", "log", "fault", "clock"]);

/** An account email as used in keys: no whitespace and no ":" (the key separator). */
export const EMAIL_RE = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/;

const KEY_RE = /^([a-z0-9]+):([a-z0-9_]+):([^\s:]+):(.+)$/;

export function fakeKey(svc: string, kind: string, email: string, id: string): string {
  return `${svc}:${kind}:${email}:${id}`;
}

/** Splits a store key; returns undefined when it does not follow the key convention. */
export function parseKey(key: string): { svc: string; kind: string; email: string; id: string } | undefined {
  const m = KEY_RE.exec(key);
  if (!m) return undefined;
  const [, svc = "", kind = "", email = "", id = ""] = m;
  return { svc, kind, email, id };
}

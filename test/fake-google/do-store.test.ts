import { beforeEach, describe, expect, it } from "vitest";
import { createFakeGoogle } from "../../fake-google/src/app";
import { DEFAULT_GWS_MCP_CALLBACKS, DoStore, LOG_ENTRY_MAX_CHARS, LOG_STRING_MAX_CHARS, MAX_BATCH_KEYS, fakeOptions, type KvBackend } from "../../fake-google/src/do-store";
import { MemoryStore, type FakeStore, type JsonValue } from "../../fake-google/src/store";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "../../src/config";

/** Largest value one key of the in-memory backend accepts, like Durable Object storage's per-value limit. */
const BACKEND_MAX_VALUE_CHARS = 64 * 1024;

/**
 * Durable Object storage semantics in memory: values are structured-cloned on write and read, keys list in
 * order, at most 128 keys per batch call and a per-value size limit. Records every call for assertions.
 */
class MapBackend implements KvBackend {
  readonly data = new Map<string, unknown>();
  readonly calls: string[] = [];

  #batch(keys: readonly string[], op: string): void {
    this.calls.push(op);
    if (keys.length > MAX_BATCH_KEYS) throw new Error(`${op}: more than ${MAX_BATCH_KEYS} keys`);
  }

  async getOne(key: string): Promise<unknown> {
    this.calls.push("getOne");
    return structuredClone(this.data.get(key));
  }

  async getMany(keys: string[]): Promise<Map<string, unknown>> {
    this.#batch(keys, "getMany");
    const out = new Map<string, unknown>();
    for (const k of keys) if (this.data.has(k)) out.set(k, structuredClone(this.data.get(k)));
    return out;
  }

  async list(prefix: string, limit?: number): Promise<Map<string, unknown>> {
    this.calls.push("list");
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.slice(0, limit ?? keys.length).map((k) => [k, structuredClone(this.data.get(k))]));
  }

  async putMany(entries: Record<string, unknown>): Promise<void> {
    this.#batch(Object.keys(entries), "putMany");
    for (const [k, v] of Object.entries(entries)) {
      if (JSON.stringify(v).length > BACKEND_MAX_VALUE_CHARS) throw new Error("value too large for one key");
      this.data.set(k, structuredClone(v));
    }
  }

  async deleteMany(keys: string[]): Promise<number> {
    this.#batch(keys, "deleteMany");
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    return n;
  }
}

const stores: Array<[string, () => FakeStore]> = [
  ["MemoryStore", () => new MemoryStore()],
  ["DoStore", () => new DoStore(new MapBackend(), { chunkChars: 1000 })],
];

describe.each(stores)("store contract: %s", (_name, make) => {
  let store: FakeStore;
  beforeEach(() => {
    store = make();
  });

  it("returns undefined for a missing key and the value after put", async () => {
    expect(await store.get("drive:file:a@fake.test:1")).toBeUndefined();
    await store.put("drive:file:a@fake.test:1", { name: "a", n: 1, tags: ["x"], nested: { ok: true, nil: null } });
    expect(await store.get("drive:file:a@fake.test:1")).toEqual({ name: "a", n: 1, tags: ["x"], nested: { ok: true, nil: null } });
  });

  it("stores scalars and overwrites on put", async () => {
    await store.put("clock:now:a@fake.test:ms", 5);
    await store.put("clock:now:a@fake.test:ms", 7);
    expect(await store.get("clock:now:a@fake.test:ms")).toBe(7);
    await store.put("k:s:a@fake.test:1", "text");
    expect(await store.get("k:s:a@fake.test:1")).toBe("text");
  });

  it("copies values on write and on read", async () => {
    const value: { list: JsonValue[] } = { list: [1] };
    await store.put("k:v:a@fake.test:1", value);
    value.list.push(2);
    const read = await store.get<{ list: number[] }>("k:v:a@fake.test:1");
    expect(read).toEqual({ list: [1] });
    read?.list.push(3);
    expect(await store.get("k:v:a@fake.test:1")).toEqual({ list: [1] });
  });

  it("lists exactly the keys with a prefix, sorted by key", async () => {
    await store.put("drive:file:b@fake.test:2", 2);
    await store.put("drive:file:a@fake.test:9", 9);
    await store.put("drive:file:a@fake.test:1", 1);
    await store.put("drive:filex:a@fake.test:1", "other kind");
    await store.put("gmail:message:a@fake.test:1", "other svc");
    expect(await store.list("drive:file:a@fake.test:")).toEqual([
      ["drive:file:a@fake.test:1", 1],
      ["drive:file:a@fake.test:9", 9],
    ]);
    expect((await store.list("drive:file:")).map(([k]) => k)).toEqual([
      "drive:file:a@fake.test:1",
      "drive:file:a@fake.test:9",
      "drive:file:b@fake.test:2",
    ]);
    expect((await store.list("")).length).toBe(5);
  });

  it("deletes a key and reports whether it existed", async () => {
    await store.put("k:v:a@fake.test:1", 1);
    expect(await store.delete("k:v:a@fake.test:1")).toBe(true);
    expect(await store.delete("k:v:a@fake.test:1")).toBe(false);
    expect(await store.get("k:v:a@fake.test:1")).toBeUndefined();
    expect(await store.list("k:")).toEqual([]);
  });

  it("round-trips a value far larger than one storage value, and shrinks it again", async () => {
    const big = { body: "E".repeat(250_000), unicode: "đ€😀".repeat(1000) };
    await store.put("fault:rule:a@fake.test:1", big);
    expect(await store.get("fault:rule:a@fake.test:1")).toEqual(big);
    expect(await store.list("fault:rule:")).toEqual([["fault:rule:a@fake.test:1", big]]);
    await store.put("fault:rule:a@fake.test:1", { small: true });
    expect(await store.get("fault:rule:a@fake.test:1")).toEqual({ small: true });
    expect(await store.delete("fault:rule:a@fake.test:1")).toBe(true);
    expect(await store.list("")).toEqual([]);
  });
});

describe("DoStore storage layout", () => {
  it("leaves no chunk behind when a large value shrinks or is deleted", async () => {
    const backend = new MapBackend();
    const store = new DoStore(backend, { chunkChars: 1000 });
    await store.put("fault:rule:a@fake.test:1", "x".repeat(300_000));
    // 300 chunks: every batch call stays within the backend's key limit.
    expect(backend.data.size).toBeGreaterThan(MAX_BATCH_KEYS);
    await store.put("fault:rule:a@fake.test:1", "y".repeat(5000));
    const afterShrink = backend.data.size;
    expect(afterShrink).toBeLessThan(10);
    await store.delete("fault:rule:a@fake.test:1");
    expect(backend.data.size).toBe(0);
  });

  it("leaves no chunk behind when a chunked value shrinks to an inline value", async () => {
    const backend = new MapBackend();
    const store = new DoStore(backend, { chunkChars: 1000 });
    await store.put("fault:rule:a@fake.test:1", "x".repeat(300_000));
    expect(backend.data.size).toBeGreaterThan(MAX_BATCH_KEYS);
    await store.put("fault:rule:a@fake.test:1", { small: true });
    // Only the header is left, holding the value inline.
    expect([...backend.data.keys()]).toEqual(["v:fault:rule:a@fake.test:1"]);
    expect(await store.get("fault:rule:a@fake.test:1")).toEqual({ small: true });
    await store.delete("fault:rule:a@fake.test:1");
    expect(backend.data.size).toBe(0);
  });

  it("refuses a value above its size bound instead of storing part of it", async () => {
    const backend = new MapBackend();
    const store = new DoStore(backend, { chunkChars: 1000, maxValueChars: 10_000 });
    await expect(store.put("fault:rule:a@fake.test:1", "z".repeat(10_001))).rejects.toThrow(/too large/);
    expect(backend.data.size).toBe(0);
  });
});

describe("DoStore request log bound", () => {
  const seed = (store: FakeStore, email: string) => store.put(`oauth:account:${email}:profile`, { email, sub: "1" });
  const entry = (i: number) => ({ ts: i, method: "GET", path: "/x", query: {} });
  const seq = (i: number) => `${String(i).padStart(13, "0")}-000000000`;

  it("keeps at most the newest logCap entries per account, oldest dropped first", async () => {
    const store = new DoStore(new MapBackend(), { logCap: 5 });
    await seed(store, "a@fake.test");
    for (let i = 0; i < 12; i++) await store.put(`log:req:a@fake.test:${seq(i)}`, entry(i));
    const kept = await store.list<{ ts: number }>("log:req:a@fake.test:");
    expect(kept.map(([, e]) => e.ts)).toEqual([7, 8, 9, 10, 11]);
  });

  it("files entries for an account that was never seeded under the unattributed log, which is bounded too", async () => {
    const store = new DoStore(new MapBackend(), { logCap: 5 });
    // An unauthenticated caller can name any email (a login hint); each name must not open a new log.
    for (let i = 0; i < 40; i++) await store.put(`log:req:attacker-${i}@fake.test:${seq(i)}`, entry(i));
    for (let i = 40; i < 45; i++) await store.put(`log:req:_:${seq(i)}`, entry(i));
    expect(await store.list("log:req:attacker-")).toEqual([]);
    expect((await store.list<{ ts: number }>("log:req:_:")).map(([, e]) => e.ts)).toEqual([40, 41, 42, 43, 44]);
    expect((await store.list("")).length).toBe(5);
  });

  it("recounts after entries are deleted, so a reset account gets its full log again", async () => {
    const store = new DoStore(new MapBackend(), { logCap: 3 });
    await seed(store, "a@fake.test");
    for (let i = 0; i < 3; i++) await store.put(`log:req:a@fake.test:${seq(i)}`, entry(i));
    for (const [k] of await store.list("log:req:a@fake.test:")) await store.delete(k);
    for (let i = 3; i < 6; i++) await store.put(`log:req:a@fake.test:${seq(i)}`, entry(i));
    expect((await store.list<{ ts: number }>("log:req:a@fake.test:")).map(([, e]) => e.ts)).toEqual([3, 4, 5]);
  });

  it("stores a normal entry unchanged", async () => {
    const store = new DoStore(new MapBackend());
    await seed(store, "a@fake.test");
    const normal = { ts: 1, method: "POST", path: "/www.googleapis.com/drive/v3/files", query: { fields: "id,name", q: ["a", "b"] } };
    await store.put(`log:req:a@fake.test:${seq(1)}`, normal);
    expect(await store.list("log:req:a@fake.test:")).toEqual([[`log:req:a@fake.test:${seq(1)}`, normal]]);
  });

  it("caps the size of each entry: long fields are truncated and the entry is marked", async () => {
    const backend = new MapBackend();
    const store = new DoStore(backend);
    await seed(store, "a@fake.test");
    // Near the largest URL a public caller can send: a 16 KB path and many long query parameters.
    const query: Record<string, string | string[]> = {};
    for (let i = 0; i < 200; i++) query[`p${i}-${"k".repeat(300)}`] = "v".repeat(1000);
    query.many = Array.from({ length: 5000 }, () => "");
    await store.put(`log:req:a@fake.test:${seq(1)}`, { ts: 1, method: "GET", path: `/x/${"p".repeat(16_000)}`, query });
    const [[, stored] = ["", null]] = await store.list<{ ts: number; method: string; path: string; truncated?: boolean }>("log:req:a@fake.test:");
    expect(stored?.ts).toBe(1);
    expect(stored?.method).toBe("GET");
    expect(stored?.path).toBe(`/x/${"p".repeat(LOG_STRING_MAX_CHARS - 3)}`);
    expect(stored?.truncated).toBe(true);
    const header = backend.data.get(`v:log:req:a@fake.test:${seq(1)}`) as { json: string };
    expect(header.json.length).toBeLessThanOrEqual(LOG_ENTRY_MAX_CHARS + 64);
  });

  it("bounds the log behind the real fake: an unauthenticated flood of picker requests with made-up hints", async () => {
    const store = new DoStore(new MapBackend(), { logCap: 4 });
    const fake = createFakeGoogle({ store, signingKey: "k".repeat(32), clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET });
    for (let i = 0; i < 20; i++) {
      // A well-formed picker request: the fake attributes its log entry to the (made-up) login hint.
      const q = new URLSearchParams({
        client_id: FAKE_CLIENT_ID,
        redirect_uri: "https://x.test/cb",
        response_type: "code",
        scope: "openid email",
        state: `s${i}`,
        code_challenge: "c".repeat(43),
        code_challenge_method: "S256",
        login_hint: `flood-${i}@fake.test`,
      });
      const picker = await fake(new Request(`http://fake/accounts.google.com/o/oauth2/v2/auth?${q}`));
      expect(picker.status).toBe(200);
      await fake(new Request("http://fake/gmail.googleapis.com/gmail/v1/users/me/labels"));
    }
    expect(await store.list("log:req:flood-")).toEqual([]);
    expect((await store.list("log:req:")).length).toBe(4);
  });
});

describe("fakeOptions (deployed fake configuration)", () => {
  const PROD = "https://gws-mcp.example.workers.dev/google/callback";
  const E2E = "https://gws-mcp-e2e.example.workers.dev/google/callback";
  const good = {
    FAKE_ADMIN_TOKEN: "a".repeat(44),
    FAKE_SIGNING_KEY: "s".repeat(44),
    FAKE_LOGIN_SECRET: "l".repeat(44),
    GWS_MCP_CALLBACKS: `${PROD} http://localhost:8787/google/callback ${E2E}`,
  };

  it("builds deploy-shaped options: admin token, login secret and exactly the configured callbacks", () => {
    const opts = fakeOptions(good);
    expect(opts.adminToken).toBe(good.FAKE_ADMIN_TOKEN);
    expect(opts.loginSecret).toBe(good.FAKE_LOGIN_SECRET);
    expect(opts.signingKey).toBe(good.FAKE_SIGNING_KEY);
    expect(opts.clientId).toBe(FAKE_CLIENT_ID);
    expect(opts.redirectUris).toEqual([PROD, "http://localhost:8787/google/callback", E2E]);
    // The options are accepted by the fake itself (it throws on a deployed fake without a redirect allowlist).
    expect(() => createFakeGoogle({ store: new MemoryStore(), ...opts })).not.toThrow();
  });

  it("allows only the local dev callback when no callbacks are configured", () => {
    for (const unset of [undefined, "", "   "]) {
      expect(fakeOptions({ ...good, GWS_MCP_CALLBACKS: unset }).redirectUris).toBe(DEFAULT_GWS_MCP_CALLBACKS);
    }
    expect(DEFAULT_GWS_MCP_CALLBACKS).toEqual(["http://localhost:8787/google/callback"]);
  });

  it("refuses malformed callbacks, naming only the var", () => {
    for (const bad of [
      "not-a-url",
      "ftp://gws-mcp.example.workers.dev/google/callback",
      "https://GWS-MCP.example.workers.dev/google/callback",
      "https://gws-mcp.example.workers.dev/google/callback#x",
      "https://user:pw@gws-mcp.example.workers.dev/google/callback",
    ]) {
      expect(() => fakeOptions({ ...good, GWS_MCP_CALLBACKS: bad }), bad).toThrow(/^fake Google: GWS_MCP_CALLBACKS must be/);
    }
    expect(() => fakeOptions({ ...good, GWS_MCP_CALLBACKS: 42 })).toThrow(/GWS_MCP_CALLBACKS/);
  });

  it("serves the picker for a configured callback and refuses near misses of it (exact match)", async () => {
    const fake = createFakeGoogle({ store: new MemoryStore(), ...fakeOptions(good) });
    const picker = (redirectUri: string) =>
      fake(
        new Request(
          `http://fake/accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
            client_id: FAKE_CLIENT_ID,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "openid email",
            state: "st-allowlist",
            code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            code_challenge_method: "S256",
          }).toString()}`,
        ),
      );
    const exact = await picker(E2E);
    expect(exact.status).toBe(200);
    expect(await exact.text()).toContain('name="login_secret"');
    for (const nearMiss of [
      `${E2E}/`,
      "http://gws-mcp-e2e.example.workers.dev/google/callback",
      `${E2E}?x=1`,
      "https://GWS-MCP-E2E.example.workers.dev/google/callback",
      "https://gws-mcp-e2e-x.example.workers.dev/google/callback",
    ]) {
      const res = await picker(nearMiss);
      expect(res.status, nearMiss).toBe(400);
      expect(res.headers.get("location"), nearMiss).toBeNull();
    }
  });

  it.each(["FAKE_ADMIN_TOKEN", "FAKE_SIGNING_KEY", "FAKE_LOGIN_SECRET"] as const)("throws naming %s when it is missing, never echoing values", (name) => {
    const env: Record<string, unknown> = { ...good };
    delete env[name];
    let message = "";
    try {
      fakeOptions(env);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(name);
    for (const v of Object.values(good)) expect(message).not.toContain(v);
  });

  it("throws when a secret is too short to be a generated one", () => {
    expect(() => fakeOptions({ ...good, FAKE_ADMIN_TOKEN: "short" })).toThrow(/FAKE_ADMIN_TOKEN/);
  });

  it("the Worker module throws at startup when the env has no fake secrets", async () => {
    // The test env is the main Worker's: it has none of the fake's secrets.
    await expect(import("../../fake-google/src/worker")).rejects.toThrow(/FAKE_ADMIN_TOKEN/);
  });
});

import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { KvBackend } from "../../fake-google/src/do-store";
import type { Fixture } from "../../fake-google/src/fixtures";
import type { FakeContext, FakeRoute } from "../../fake-google/src/routes/index";
import type { FakeStore } from "../../fake-google/src/store";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

export const G = "https://www.googleapis.com/auth/";
/** The clock the seeded accounts run on. */
export const NOW = Date.parse("2026-11-10T03:00:00.000Z");
/** What fixtures call the seeded account. */
export const FIXTURE_EMAIL = "alice@fake.test";

const transport = createTransport(env, loadConfig(env));

/** A fresh seeded account (preset `default` unless told otherwise) with a token for `scopes`. */
export async function account(scopes: string[], opts: { email?: string; preset?: string; prefix?: string } = {}) {
  const email = opts.email ?? uniqueEmail(opts.prefix ?? "mk");
  await fake.seed({ accounts: [{ email, sub: "100000000000000000001", preset: opts.preset ?? "default" }], now: NOW });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, token: tokens.accessToken };
}

export function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fakeFetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

/** A request with a JSON body (or none), extra headers allowed. */
export function send(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api(token, path, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

export interface GoogleErrorBody {
  error: { code: number; message: string; status: string; errors?: Array<{ reason: string; message: string }>; details?: Array<Record<string, unknown>> };
}

export function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

/** Each route must demand exactly the Discovery scopes of the method it implements. */
export function expectRouteScopes(routes: FakeRoute[], cases: ReadonlyArray<{ fn: string; method: FakeRoute["method"]; path: string }>): void {
  for (const c of cases) {
    const route = routes.find((x) => x.method === c.method && x.pattern.test(c.path));
    expect(route, `${c.method} ${c.path}`).toBeDefined();
    const meta = generatedFns.find((f) => f.name === c.fn)?.method;
    expect(meta, c.fn).toBeDefined();
    expect([...(route?.scopes ?? [])].sort(), c.fn).toEqual([...(meta?.scopes ?? [])].sort());
  }
}

/** Calls one route module's handler directly against `store`, as the app would after the access check. */
export async function callRoute(
  routes: FakeRoute[],
  store: FakeStore,
  method: FakeRoute["method"],
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`http://fake-google${path}`);
  const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
  const match = route?.pattern.exec(url.pathname);
  if (!route || !match) throw new Error(`no route for ${method} ${path}`);
  const init = body === undefined ? { headers } : { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
  const req = new Request(url, { method, ...init });
  const ctx: FakeContext = { req, url, path: url.pathname, match, store, email: "do@fake.test", scopes: route.scopes, now: () => NOW };
  return route.handle(ctx);
}

/** Replays a fixture's request against the fake and returns the body with the account email normalised. */
export async function replay(token: string, email: string, fx: Fixture, body?: unknown, headers: Record<string, string> = {}) {
  const query = new URLSearchParams(fx.request.query as Record<string, string> | undefined).toString();
  const res = await send(token, fx.request.method, `${fx.request.path}${query ? `?${query}` : ""}`, body, headers);
  expect(res.status, fx.id).toBe(fx.response.status);
  const text = (await res.text()).replaceAll(email, FIXTURE_EMAIL);
  return text === "" ? null : (JSON.parse(text) as unknown);
}

/** Durable Object storage semantics in memory: values are cloned on write and read, keys list in order. */
export function memoryBackend(): KvBackend {
  const data = new Map<string, unknown>();
  const keys = (prefix: string) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
  return {
    getOne: async (k) => structuredClone(data.get(k)),
    getMany: async (ks) => new Map(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    list: async (prefix, limit) => new Map(keys(prefix).slice(0, limit).map((k) => [k, structuredClone(data.get(k))])),
    putMany: async (entries) => {
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
    },
    deleteMany: async (ks) => ks.filter((k) => data.delete(k)).length,
  };
}

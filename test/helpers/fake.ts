import { env } from "cloudflare:workers";
import type { FaultSpec, RequestLogEntry, SeedRequest, StateSnapshot } from "../../fake-google/src/control";

/** Origin used for every call through the FAKE_GOOGLE service binding (the host is ignored by the binding). */
export const FAKE_ORIGIN = "http://fake-google";

/** Raw fetch against the fake through the service binding. `path` starts with `/`. */
export function fakeFetch(path: string, init?: RequestInit): Promise<Response> {
  return env.FAKE_GOOGLE.fetch(`${FAKE_ORIGIN}${path}`, { redirect: "manual", ...init });
}

async function control<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fakeFetch(`/__fake/${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fake control ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const fake = {
  seed: (req: SeedRequest) => control<{ ok: true; accounts: string[] }>("POST", "seed", req),
  fault: (spec: FaultSpec) => control<{ ok: true; id: string }>("POST", "faults", spec),
  reset: (email?: string) => control<{ ok: true; deleted: number }>("POST", "reset", email ? { email } : {}),
  requests: async (email: string) =>
    (await control<{ requests: RequestLogEntry[] }>("GET", `requests?email=${encodeURIComponent(email)}`)).requests,
  state: (email: string) => control<StateSnapshot>("GET", `state?email=${encodeURIComponent(email)}`),
};

/** A per-test unique fake account email, so concurrent test files never share fake state. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@fake.test`;
}

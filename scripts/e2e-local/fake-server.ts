// The fake Google as a plain Node HTTP server on 127.0.0.1 (a random port), for the local E2E run. The same fetch
// handler the Workers tests use, over an in-memory store; it lives only as long as the run.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createFakeGoogle } from "../../fake-google/src/app";
import { MemoryStore } from "../../fake-google/src/store";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "../../src/config";

export interface FakeServer {
  /** `http://127.0.0.1:<port>`: the local config's fake Google URL. */
  origin: string;
  /** Every request path the fake served, as "METHOD /host/path". */
  seen: string[];
  /** Delays every Google API answer (not OAuth, not control routes) by this many milliseconds. */
  apiDelayMs: number;
  close(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const handler = createFakeGoogle({
    store: new MemoryStore(),
    signingKey: `gws-mcp-local-e2e-${crypto.randomUUID()}`,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    // A Desktop client redirects to a random loopback port, which no fixed list can name.
  });
  const seen: string[] = [];
  const state = { apiDelayMs: 0 };
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      }
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://fake-google");
      seen.push(`${method} ${url.pathname}`);
      if (state.apiDelayMs > 0 && !/^\/(?:__fake|oauth2\.|accounts\.|openidconnect\.)/.test(url.pathname)) {
        await new Promise((resolve) => setTimeout(resolve, state.apiDelayMs));
      }
      const response = await handler(
        new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }), redirect: "manual" }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    get apiDelayMs() {
      return state.apiDelayMs;
    },
    set apiDelayMs(ms: number) {
      state.apiDelayMs = ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The fake's control routes (no admin token: the fake listens on loopback only, for this run only). */
export class FakeControl {
  constructor(readonly origin: string) {}

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`fake ${path} -> ${res.status}`);
  }

  seed(accounts: Array<{ email: string; sub: string; preset?: string }>): Promise<void> {
    return this.post("/__fake/seed", { accounts });
  }

  fault(rule: Record<string, unknown>): Promise<void> {
    return this.post("/__fake/faults", rule);
  }

  async state(email: string): Promise<{ grants: Record<string, string[]>; resources: Record<string, unknown> }> {
    const res = await fetch(`${this.origin}/__fake/state?email=${encodeURIComponent(email)}`);
    return (await res.json()) as { grants: Record<string, string[]>; resources: Record<string, unknown> };
  }

  async requests(email: string): Promise<Array<{ method: string; path: string }>> {
    const res = await fetch(`${this.origin}/__fake/requests?email=${encodeURIComponent(email)}`);
    return ((await res.json()) as { requests: Array<{ method: string; path: string }> }).requests;
  }

  /** The user at the consent screen: approves (or denies) `authUrl` as `email`; returns where Google redirects. */
  async consent(authUrl: string, email: string, decision: "allow" | "deny" = "allow"): Promise<URL> {
    const u = new URL(authUrl);
    if (u.origin !== this.origin) throw new Error("the sign-in URL does not point at the run's fake Google");
    const res = await fetch(`${this.origin}${u.pathname}/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(u.searchParams), email, decision }).toString(),
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status !== 302 || location === null) throw new Error(`fake consent -> ${res.status}`);
    return new URL(location);
  }
}

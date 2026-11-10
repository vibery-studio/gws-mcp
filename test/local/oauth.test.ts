import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransport, type Transport } from "../../src/google/transport";
import {
  CALLBACK_PATH,
  FLOW_COOKIE,
  LoopbackFlowError,
  START_PATH,
  connectScopes,
  pkceChallenge,
  runLoopbackFlow,
  type AbandonedGrant,
  type LoopbackFlowOptions,
} from "../../src/local/oauth";
import { ensurePrivateDir } from "../../src/local/paths";
import { openSecrets, type LocalSecrets } from "../../src/local/secrets";
import { localConfig, memoryKeyring, stubFakeGoogle, tempDir, type FakeGoogle } from "./helpers";

const config = localConfig();

interface Answer {
  status: number;
  body: string;
  location: string | null;
  setCookie: string[];
}

/** One raw HTTP request to a listener, with a chosen Host header and cookie (fetch cannot set either freely). */
function request(o: { port: number; path: string; host: string; method?: string; cookie?: string; address?: string; agent?: http.Agent }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host };
    if (o.cookie !== undefined) headers.cookie = o.cookie;
    const req = http.request(
      { host: o.address ?? "127.0.0.1", port: o.port, path: o.path, method: o.method ?? "GET", headers, ...(o.agent ? { agent: o.agent } : {}) },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location ?? null, setCookie: res.headers["set-cookie"] ?? [] }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** True when nothing accepts connections on host:port. */
function refused(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether this machine can listen on the IPv6 loopback. */
async function hasIpv6Loopback(): Promise<boolean> {
  const s = net.createServer();
  const ok = await new Promise<boolean>((resolve) => {
    s.once("error", () => resolve(false));
    s.listen(0, "::1", () => resolve(true));
  });
  if (ok) await new Promise<void>((resolve) => s.close(() => resolve()));
  return ok;
}

let fake: FakeGoogle;
let secrets: LocalSecrets;
let cleanup: () => void;
let sent: Array<{ url: string; body: string }>;
let send: Transport;
/** Delays the token endpoint's answer, to hold an exchange in flight. */
let tokenDelayMs = 0;

beforeEach(async () => {
  fake = stubFakeGoogle({ anyRedirectUri: true });
  const t = tempDir();
  cleanup = t.cleanup;
  ensurePrivateDir(t.dir);
  secrets = await openSecrets({ dir: t.dir, keyring: { keyring: memoryKeyring() } });
  const inner = createTransport({ FAKE_GOOGLE: { fetch: (u, init) => fake.handler(new Request(u, init)) } }, config);
  sent = [];
  tokenDelayMs = 0;
  send = async (url, init) => {
    sent.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (tokenDelayMs > 0 && url.endsWith("/token")) await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
    return inner(url, init);
  };
  await fake.handler(
    new Request("http://fake-google/__fake/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accounts: [{ email: "me@fake.test", sub: "sub-me" }] }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** What the user does at the (fake) consent screen: returns where Google redirects the browser. */
async function consent(authUrl: string, decision: "allow" | "deny" = "allow"): Promise<URL> {
  const u = new URL(authUrl);
  const res = await fake.handler(
    new Request(`http://fake-google${u.pathname}/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(u.searchParams), email: "me@fake.test", decision }).toString(),
      redirect: "manual",
    }),
  );
  const location = res.headers.get("location");
  if (res.status !== 302 || location === null) throw new Error(`consent failed: ${res.status}`);
  return new URL(location);
}

/** The browser opening the start link: the redirect to Google and the flow cookie it sets. */
async function openStart(startUrl: string): Promise<{ answer: Answer; authUrl: string; cookie: string }> {
  const u = new URL(startUrl);
  const answer = await request({ port: Number(u.port), path: `${u.pathname}${u.search}`, host: u.host });
  const cookie = (answer.setCookie[0] ?? "").split(";")[0] ?? "";
  return { answer, authUrl: answer.location ?? "", cookie };
}

/** Starts a flow and waits until the start link is handed to the opener. */
async function start(o: Partial<LoopbackFlowOptions> = {}) {
  let port = 0;
  let startUrl = "";
  let ready: () => void = () => undefined;
  const announced = new Promise<void>((resolve) => (ready = resolve));
  const opened: string[] = [];
  const fallbacks: string[] = [];
  const abandoned: AbandonedGrant[] = [];
  const announce = (url: string) => {
    startUrl = url;
    ready();
  };
  const flow = runLoopbackFlow({
    config,
    clientType: "desktop",
    port: 0,
    secrets: secrets.source,
    send,
    redactor: secrets.redactor,
    scopes: connectScopes("narrow", ["gmail", "drive"]),
    open: async (url) => {
      opened.push(url);
      announce(url);
    },
    onFallback: (url) => {
      fallbacks.push(url);
      announce(url);
    },
    discard: async (grant) => void abandoned.push(grant),
    onListening: (p) => (port = p),
    timeoutMs: 10_000,
    ...o,
  });
  // A flow that fails before it opens the browser (a port in use) rejects here instead of hanging.
  const failed = new Promise<never>((_resolve, reject) => void flow.catch(reject));
  failed.catch(() => undefined);
  await Promise.race([announced, failed]);
  return { flow, port, startUrl, opened, fallbacks, abandoned };
}

/** Opens the start link, consents and returns the callback path plus the cookie the browser holds. */
async function signIn(startUrl: string, decision: "allow" | "deny" = "allow") {
  const s = await openStart(startUrl);
  const back = await consent(s.authUrl, decision);
  return { ...s, back, path: `${back.pathname}${back.search}` };
}

describe("loopback OAuth with a Desktop client", () => {
  it("binds 127.0.0.1 on a random port, hands the opener only a one-shot start link, and asks Google for offline, incremental access with PKCE S256", async () => {
    const listen = vi.spyOn(http.Server.prototype, "listen");
    const remember = vi.spyOn(secrets.redactor, "remember");
    const { flow, port, startUrl, opened, fallbacks } = await start();
    expect(listen.mock.calls[0]?.[0]).toMatchObject({ host: "127.0.0.1", port: 0 });
    expect(listen).toHaveBeenCalledTimes(1);
    listen.mockRestore();
    expect(port).toBeGreaterThan(0);
    // The opener (argv of `open`/`xdg-open`) never sees the state, the challenge or Google's URL.
    expect(opened).toEqual([startUrl]);
    expect(startUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}${START_PATH}\\?t=[A-Za-z0-9_-]{43}$`));
    expect(fallbacks).toEqual([]);

    const { answer, authUrl, cookie, back, path } = await signIn(startUrl);
    expect(answer.status).toBe(302);
    expect(answer.setCookie).toHaveLength(1);
    expect(answer.setCookie[0]).toMatch(new RegExp(`^${FLOW_COOKIE}=[A-Za-z0-9_-]{43}; Path=${CALLBACK_PATH}; Max-Age=\\d+; HttpOnly; SameSite=Lax$`));
    const q = new URL(authUrl).searchParams;
    expect(q.get("redirect_uri")).toBe(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]));

    const res = await request({ port, path, host: `127.0.0.1:${port}`, cookie });
    expect(res.status).toBe(200);
    const result = await flow;
    expect(result).toMatchObject({ email: "me@fake.test", sub: "sub-me", refreshToken: expect.stringMatching(/^1\/\/fake-/) });

    const exchange = sent.find((s) => s.url.endsWith("/token"));
    const verifier = new URLSearchParams(exchange?.body ?? "").get("code_verifier") ?? "";
    expect(await pkceChallenge(verifier)).toBe(q.get("code_challenge"));
    expect(new URLSearchParams(exchange?.body ?? "").get("redirect_uri")).toBe(`http://127.0.0.1:${port}${CALLBACK_PATH}`);

    // Every token from the exchange is remembered for redaction (the fake's are Google-shaped, so the spy is what
    // proves it), and the listener is gone.
    const remembered = remember.mock.calls.map(([v]) => v);
    expect(remembered).toEqual(expect.arrayContaining([result.refreshToken, back.searchParams.get("code")]));
    expect(remembered.some((v) => v.startsWith("ya29.fake-"))).toBe(true);
    expect(await refused(port)).toBe(true);
  });

  it("refuses a callback without the flow cookie, or with another one, and keeps waiting for the real browser", async () => {
    const { flow, port, startUrl } = await start();
    const host = `127.0.0.1:${port}`;
    const { path, cookie } = await signIn(startUrl);
    expect((await request({ port, path, host })).status).toBe(400);
    expect((await request({ port, path, host, cookie: `${FLOW_COOKIE}=${"x".repeat(43)}` })).status).toBe(400);
    expect((await request({ port, path, host, cookie: `${cookie}; ${cookie}` })).status).toBe(400);
    expect(sent.filter((s) => s.url.endsWith("/token"))).toEqual([]);
    expect((await request({ port, path, host, cookie })).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ email: "me@fake.test" });
  });

  it("serves the start link once: a second visit gets no cookie and no redirect", async () => {
    const { flow, port, startUrl } = await start();
    const first = await openStart(startUrl);
    expect(first.answer.status).toBe(302);
    const again = await openStart(startUrl);
    expect(again.answer.status).toBe(410);
    expect(again.answer.setCookie).toEqual([]);
    expect(again.answer.location).toBeNull();
    const wrong = new URL(startUrl);
    wrong.searchParams.set("t", "y".repeat(43));
    expect((await request({ port, path: `${wrong.pathname}${wrong.search}`, host: wrong.host })).status).toBe(400);
    const back = await consent(first.authUrl);
    expect((await request({ port, path: `${back.pathname}${back.search}`, host: `127.0.0.1:${port}`, cookie: first.cookie })).status).toBe(200);
    await flow;
  });

  it("refuses a callback with a wrong or missing state and keeps waiting for the real one", async () => {
    const { flow, port, startUrl } = await start();
    const host = `127.0.0.1:${port}`;
    const { back, cookie, path } = await signIn(startUrl);
    const forged = new URL(back);
    forged.searchParams.set("state", "x".repeat(43));
    expect((await request({ port, path: `${forged.pathname}${forged.search}`, host, cookie })).status).toBe(400);
    expect((await request({ port, path: `${CALLBACK_PATH}?code=abc`, host, cookie })).status).toBe(400);
    expect((await request({ port, path: `${path}&state=${"y".repeat(43)}`, host, cookie })).status).toBe(400);
    expect((await request({ port, path, host, cookie })).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ email: "me@fake.test" });
  });

  it("serves only GET on its two paths and the exact host, so other pages cannot drive it", async () => {
    const { flow, port, startUrl } = await start();
    const s = new URL(startUrl);
    const startPath = `${s.pathname}${s.search}`;
    expect((await request({ port, path: startPath, host: `localhost:${port}` })).status).toBe(400);
    expect((await request({ port, path: startPath, host: `127.0.0.1:${port}`, method: "POST" })).status).toBe(405);
    const { cookie, path } = await signIn(startUrl);
    expect((await request({ port, path, host: `localhost:${port}`, cookie })).status).toBe(400);
    expect((await request({ port, path, host: "evil.example", cookie })).status).toBe(400);
    expect((await request({ port, path: path.replace(CALLBACK_PATH, "/other"), host: `127.0.0.1:${port}`, cookie })).status).toBe(404);
    expect((await request({ port, path, host: `127.0.0.1:${port}`, method: "POST", cookie })).status).toBe(405);
    expect((await request({ port, path, host: `127.0.0.1:${port}`, cookie })).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ sub: "sub-me" });
  });

  it("lets only the first callback with the state through, even while its exchange is still running", async () => {
    tokenDelayMs = 300;
    const { flow, port, startUrl } = await start();
    const { path, cookie } = await signIn(startUrl);
    const first = request({ port, path, host: `127.0.0.1:${port}`, cookie });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await request({ port, path, host: `127.0.0.1:${port}`, cookie })).status).toBe(410);
    expect((await first).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ email: "me@fake.test" });
    expect(sent.filter((x) => x.url.endsWith("/token"))).toHaveLength(1);
  });

  it("ends without connecting when Google reports a refusal", async () => {
    const { flow, port, startUrl } = await start();
    const { path, cookie } = await signIn(startUrl, "deny");
    expect((await request({ port, path, host: `127.0.0.1:${port}`, cookie })).status).toBe(400);
    await expect(flow).rejects.toThrow(/did not grant access/);
    expect(sent.filter((s) => s.url.endsWith("/token"))).toEqual([]);
    expect(await refused(port)).toBe(true);
  });

  it("ends without connecting when the code does not exchange, and the state is spent", async () => {
    const { flow, port, startUrl } = await start();
    const { back, cookie } = await signIn(startUrl);
    back.searchParams.set("code", "not-a-code");
    expect((await request({ port, path: `${back.pathname}${back.search}`, host: `127.0.0.1:${port}`, cookie })).status).toBe(502);
    await expect(flow).rejects.toBeInstanceOf(LoopbackFlowError);
    expect(await refused(port)).toBe(true);
  });

  it("closes the listener, and the connections still open to it, at the timeout", async () => {
    const { flow, port } = await start({ timeoutMs: 400 });
    // An idle connection the browser (or anyone) left open: it must not outlive the flow.
    const idle = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => idle.once("connect", () => resolve()));
    const closed = new Promise<number>((resolve) => idle.once("close", () => resolve(Date.now())));
    await expect(flow).rejects.toThrow(/no Google sign-in arrived within/);
    const at = Date.now();
    expect((await closed) - at).toBeLessThan(1000);
    expect(await refused(port)).toBe(true);
  });

  it("hands back a grant whose exchange finished after the timeout, so it can be revoked", async () => {
    tokenDelayMs = 600;
    const { flow, port, startUrl, abandoned } = await start({ timeoutMs: 1500 });
    const { path, cookie } = await signIn(startUrl);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const callback = request({ port, path, host: `127.0.0.1:${port}`, cookie }).catch(() => undefined);
    await expect(flow).rejects.toThrow(/no Google sign-in arrived within/);
    await callback;
    expect(abandoned).toEqual([{ accessToken: expect.stringMatching(/^ya29\.fake-/), refreshToken: expect.stringMatching(/^1\/\/fake-/), sub: "sub-me" }]);
  });

  it("prints the start link only when the browser cannot be opened, and the sign-in still works from it", async () => {
    const { flow, port, startUrl, fallbacks } = await start({ open: () => Promise.reject(new Error("no opener")) });
    expect(fallbacks).toEqual([startUrl]);
    const { path, cookie } = await signIn(startUrl);
    expect((await request({ port, path, host: `127.0.0.1:${port}`, cookie })).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ email: "me@fake.test" });
  });
});

describe("loopback OAuth with a Web client", () => {
  it("binds 127.0.0.1 and [::1] at the fixed port, redirects to localhost, and accepts only the localhost host", async (t) => {
    if (!(await hasIpv6Loopback())) return t.skip();
    const fixed = await freePort();
    const { flow, port, startUrl } = await start({ clientType: "web", port: fixed });
    expect(port).toBe(fixed);
    expect(startUrl).toMatch(new RegExp(`^http://localhost:${fixed}${START_PATH}\\?t=`));
    // Nothing else can take the IPv6 side of localhost while the flow listens.
    const thief = net.createServer();
    const stolen = await new Promise<string>((resolve) => {
      thief.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      thief.listen({ host: "::1", port: fixed, ipv6Only: true }, () => resolve("bound"));
    });
    if (stolen === "bound") await new Promise<void>((resolve) => thief.close(() => resolve()));
    expect(stolen).toBe("EADDRINUSE");

    const s = await openStart(startUrl);
    const q = new URL(s.authUrl).searchParams;
    expect(q.get("redirect_uri")).toBe(`http://localhost:${fixed}${CALLBACK_PATH}`);
    const back = await consent(s.authUrl);
    const path = `${back.pathname}${back.search}`;
    expect((await request({ port: fixed, path, host: `127.0.0.1:${fixed}`, cookie: s.cookie })).status).toBe(400);
    // The browser may reach localhost over IPv6: the same checks answer there.
    expect((await request({ port: fixed, path, host: `localhost:${fixed}`, cookie: s.cookie, address: "::1" })).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ email: "me@fake.test" });
    expect(await refused(fixed)).toBe(true);
    expect(await refused(fixed, "::1")).toBe(true);
  });

  it("refuses to start when the IPv4 port is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(start({ clientType: "web", port: taken })).rejects.toThrow(new RegExp(`port ${taken} on 127\\.0\\.0\\.1 is in use`));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("proceeds on 127.0.0.1 alone when the machine has no IPv6 loopback (nothing can listen on [::1] then)", async () => {
    for (const code of ["EADDRNOTAVAIL", "EAFNOSUPPORT"]) {
      const fixed = await freePort();
      const { flow, port, startUrl } = await start({ clientType: "web", port: fixed, bindError: (host) => (host === "::1" ? code : undefined) });
      expect(port).toBe(fixed);
      // Only the IPv4 listener exists: the simulated machine has no [::1] for anyone.
      expect(await refused(fixed, "::1")).toBe(true);
      const { path, cookie } = await signIn(startUrl);
      expect((await request({ port: fixed, path, host: `localhost:${fixed}`, cookie })).status).toBe(200);
      await expect(flow).resolves.toMatchObject({ email: "me@fake.test" });
      expect(await refused(fixed)).toBe(true);
    }
  });

  it("still refuses to start, and frees the IPv4 side, on any other [::1] bind error", async () => {
    for (const code of ["EADDRINUSE", "EACCES"]) {
      const fixed = await freePort();
      await expect(start({ clientType: "web", port: fixed, bindError: (host) => (host === "::1" ? code : undefined) })).rejects.toThrow(/\[::1\]/);
      expect(await refused(fixed)).toBe(true);
    }
  });

  it("refuses to start, and frees the IPv4 side, when something holds [::1] at the port", async (t) => {
    if (!(await hasIpv6Loopback())) return t.skip();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen({ host: "::1", port: 0, ipv6Only: true }, resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(start({ clientType: "web", port })).rejects.toThrow(new RegExp(`port ${port} on \\[::1\\] is in use`));
      expect(await refused(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

import type http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseTrustedProxies } from "../../src/runtime/node/config";
import { clientAddress, createHttpFront, type FetchHandler, type HttpFront, requestUrl } from "../../src/runtime/node/http";

const PUBLIC = "https://gws.example.com";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const fronts: HttpFront[] = [];
afterEach(async () => {
  for (const f of fronts.splice(0)) await f.drain(1000);
});

/** A front on 127.0.0.1 whose Worker echoes what it received. */
async function start(opts: { maxBodyBytes?: number; trusted?: string; handler?: FetchHandler; healthy?: () => boolean } = {}): Promise<{ port: number; front: HttpFront; logs: string[] }> {
  const logs: string[] = [];
  const echo: FetchHandler = async (request) => {
    const seen: Seen = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() };
    return Response.json(seen, { headers: [["set-cookie", "a=1"], ["set-cookie", "b=2"]] });
  };
  const front = createHttpFront(opts.handler ?? echo, {
    publicBaseUrl: PUBLIC,
    maxBodyBytes: opts.maxBodyBytes ?? 1024,
    trustedProxies: opts.trusted === undefined ? null : parseTrustedProxies(opts.trusted),
    clientIpHeader: "x-forwarded-for",
    healthy: opts.healthy ?? (() => true),
    version: "9.9.9",
    log: (level, msg, fields) => logs.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`),
  });
  fronts.push(front);
  await new Promise<void>((resolve) => front.server.listen(0, "127.0.0.1", resolve));
  return { port: (front.server.address() as net.AddressInfo).port, front, logs };
}

/** Sends raw bytes and returns the raw response (the connection is closed by the server or after `waitMs`). */
function raw(port: number, text: string, waitMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let out = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      out += d;
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(out));
    socket.write(text);
    setTimeout(() => socket.destroy(), waitMs);
  });
}

const statusOf = (response: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]);

async function get(port: number, target: string, headers: Record<string, string> = {}): Promise<{ status: number; seen?: Seen; res: Response }> {
  const res = await fetch(`http://127.0.0.1:${port}${target}`, { headers });
  const seen = res.headers.get("content-type")?.includes("json") ? ((await res.json()) as Seen) : undefined;
  return { status: res.status, ...(seen ? { seen } : {}), res };
}

describe("the Node host HTTP front", () => {
  it("builds the request URL and Host from the public origin, whatever Host the client sends", async () => {
    const { port } = await start();
    const { status, seen, res } = await get(port, "/mcp/x?a=1&b=%2F", { host: "evil.example" });
    expect(status).toBe(200);
    expect(seen?.url).toBe(`${PUBLIC}/mcp/x?a=1&b=%2F`);
    expect(seen?.headers.host).toBe("gws.example.com");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it.each([
    ["absolute-form", "GET http://evil.example/x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"],
    ["absolute-form on the public host", `GET ${PUBLIC}/mcp HTTP/1.1\r\nHost: gws.example.com\r\nConnection: close\r\n\r\n`],
    ["asterisk-form", "OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"],
    ["scheme-relative", "GET //evil.example/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"],
    ["backslash scheme-relative", "GET /\\evil.example/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"],
  ])("refuses this request target with 400 and never calls the Worker: %s", async (_what, request) => {
    let called = false;
    const { port } = await start({
      handler: async () => {
        called = true;
        return new Response("ok");
      },
    });
    expect(statusOf(await raw(port, request))).toBe(400);
    expect(called).toBe(false);
  });

  it("sets CF-Connecting-IP from the socket and drops client-sent cf-* and forwarding headers", async () => {
    const { port } = await start();
    const { seen } = await get(port, "/", {
      "cf-connecting-ip": "6.6.6.6",
      "cf-ipcountry": "XX",
      "x-forwarded-for": "6.6.6.6",
      "x-real-ip": "6.6.6.6",
      forwarded: "for=6.6.6.6",
      "x-custom": "kept",
    });
    expect(seen?.headers["cf-connecting-ip"]).toBe("127.0.0.1");
    for (const h of ["cf-ipcountry", "x-forwarded-for", "x-real-ip", "forwarded"]) expect(seen?.headers).not.toHaveProperty(h);
    expect(seen?.headers["x-custom"]).toBe("kept");
  });

  it("takes the client address from X-Forwarded-For only when the peer is a trusted proxy", async () => {
    const { port } = await start({ trusted: "127.0.0.1" });
    expect((await get(port, "/", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).seen?.headers["cf-connecting-ip"]).toBe("203.0.113.9");
    expect((await get(port, "/", { "x-forwarded-for": "garbage" })).seen?.headers["cf-connecting-ip"]).toBe("127.0.0.1");
    expect((await get(port, "/")).seen?.headers["cf-connecting-ip"]).toBe("127.0.0.1");
  });

  it("passes the body through and caps it with 413", async () => {
    const { port } = await start({ maxBodyBytes: 1024 });
    const ok = await fetch(`http://127.0.0.1:${port}/form`, { method: "POST", body: "x".repeat(1024) });
    expect(((await ok.json()) as Seen).body).toHaveLength(1024);
    const declared = await fetch(`http://127.0.0.1:${port}/form`, { method: "POST", body: "x".repeat(1025) });
    expect(declared.status).toBe(413);
    expect(declared.headers.get("connection")).toBe("close");
    const chunked = await raw(port, `POST /form HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n400\r\n${"x".repeat(1024)}\r\n10\r\n${"y".repeat(16)}\r\n0\r\n\r\n`);
    expect(statusOf(chunked)).toBe(413);
  });

  it("answers /healthz itself: 200 with ok and version, 503 when the database check fails or throws", async () => {
    let state: "ok" | "down" | "throws" = "ok";
    const { port, logs } = await start({
      healthy: () => {
        if (state === "throws") throw new Error("disk I/O error");
        return state === "ok";
      },
      handler: async () => new Response("the Worker must not see /healthz", { status: 418 }),
    });
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ ok: true, version: "9.9.9" });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`, { method: "HEAD" })).status).toBe(200);
    state = "down";
    const down = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false });
    state = "throws";
    const threw = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(threw.status).toBe(503);
    expect(await threw.text()).not.toContain("disk");
    expect(logs.join("\n")).toContain("health check failed");
    // Other methods and paths go to the Worker as before.
    expect((await fetch(`http://127.0.0.1:${port}/healthz`, { method: "POST", body: "x" })).status).toBe(418);
    expect((await fetch(`http://127.0.0.1:${port}/healthz/x`)).status).toBe(418);
  });

  it("answers a Worker exception with a bare 500 and logs it", async () => {
    const { port, logs } = await start({
      handler: async () => {
        throw new Error("boom detail");
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expect(logs.some((l) => l.startsWith("error the Worker fetch threw") && l.includes("boom detail"))).toBe(true);
  });

  it("drains: an in-flight request completes, new connections are refused, then the server is closed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port, front } = await start({
      handler: async () => {
        await gate;
        return new Response("done");
      },
    });
    const inFlight = fetch(`http://127.0.0.1:${port}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const drained = front.drain(5000);
    await expect(fetch(`http://127.0.0.1:${port}/new`)).rejects.toThrow();
    release();
    const res = await inFlight;
    expect([res.status, await res.text()]).toEqual([200, "done"]);
    expect(await drained).toEqual({ abandoned: 0 });
    expect(front.server.listening).toBe(false);
  });

  it("drain closes requests still running at the deadline", async () => {
    const { port, front } = await start({ handler: () => new Promise<Response>(() => {}) });
    const stuck = fetch(`http://127.0.0.1:${port}/stuck`).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await front.drain(200)).toEqual({ abandoned: 1 });
    expect(await stuck).toBeInstanceOf(Error);
  });

  it("sets timeouts for headers, the request and idle keep-alive", async () => {
    const { front } = await start();
    const s: http.Server = front.server;
    expect([s.headersTimeout, s.requestTimeout, s.keepAliveTimeout]).toEqual([20_000, 60_000, 65_000]);
  });
});

describe("clientAddress", () => {
  const trusted = parseTrustedProxies("10.0.0.0/8, 172.16.0.1");
  it.each([
    ["no trusted proxies: the peer", "203.0.113.1", { "x-forwarded-for": "1.1.1.1" }, null, "203.0.113.1"],
    ["an untrusted peer: the peer, its header ignored", "203.0.113.1", { "x-forwarded-for": "1.1.1.1" }, trusted, "203.0.113.1"],
    ["a trusted peer: the rightmost untrusted hop", "10.0.0.2", { "x-forwarded-for": "6.6.6.6, 1.1.1.1, 172.16.0.1" }, trusted, "1.1.1.1"],
    ["only trusted hops: the leftmost", "10.0.0.2", { "x-forwarded-for": "10.0.0.9, 172.16.0.1" }, trusted, "10.0.0.9"],
    ["a malformed hop: the peer", "10.0.0.2", { "x-forwarded-for": "1.1.1.1, nonsense" }, trusted, "10.0.0.2"],
    ["no header: the peer", "10.0.0.2", {}, trusted, "10.0.0.2"],
    ["an IPv4-mapped peer", "::ffff:10.0.0.2", { "x-forwarded-for": "2001:db8::1" }, trusted, "2001:db8::1"],
  ] as const)("%s", (_what, peer, headers, list, expected) => {
    expect(clientAddress(peer, headers as http.IncomingHttpHeaders, list, "x-forwarded-for")).toBe(expected);
  });

  it("takes a one-address header as is from a trusted proxy", () => {
    expect(clientAddress("10.0.0.2", { "cf-connecting-ip": "1.1.1.1" }, trusted, "cf-connecting-ip")).toBe("1.1.1.1");
    expect(clientAddress("10.0.0.2", { "x-real-ip": "1.1.1.1, 2.2.2.2" }, trusted, "x-real-ip")).toBe("10.0.0.2");
  });
});

describe("requestUrl", () => {
  it("accepts origin-form targets only", () => {
    expect(requestUrl("/a/../b?x=1", PUBLIC).href).toBe(`${PUBLIC}/b?x=1`);
    for (const bad of [undefined, "", "*", "a/b", "http://x/", "//x/y", "/\\x/y"]) expect(() => requestUrl(bad, PUBLIC), String(bad)).toThrow(/Bad request target/);
  });
});

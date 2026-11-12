import http from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { plainAddress, type ClientIpHeader, type TrustedProxies } from "./config";

/**
 * The node:http front of the Node host: turns each Node request into the Fetch `Request` a Worker receives and
 * writes the `Response` back, with the guarantees Cloudflare's edge gives a Worker:
 *
 * - The URL is the configured public origin plus the request target. Only origin-form targets ("/path?q") are
 *   served; an absolute-form ("http://other/x"), authority-form or asterisk-form target, or one that would resolve
 *   to another origin ("//host/x", "/\host"), is refused with 400. The Host header is set to the public host.
 * - CF-Connecting-IP is the client address: the socket's peer, or, only when that peer is a configured trusted
 *   proxy, the address the proxy reports in its header. Any client-sent `cf-*` or forwarding header is dropped.
 * - The body is read whole, up to `maxBodyBytes` (413 beyond it).
 * - Header, request and keep-alive timeouts bound slow or idle clients.
 */

export type FetchHandler = (request: Request) => Promise<Response>;
export type Logger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface HttpFrontOptions {
  publicBaseUrl: string;
  maxBodyBytes: number;
  trustedProxies: TrustedProxies | null;
  clientIpHeader: ClientIpHeader;
  /** True when the host can serve: answers `GET /healthz` (200, or 503 when this returns false or throws). */
  healthy: () => boolean;
  /** The version `/healthz` reports. */
  version: string;
  log: Logger;
}

export interface HttpFront {
  server: http.Server;
  /** Stops accepting, lets in-flight requests finish for up to `timeoutMs`, then closes every connection. */
  drain(timeoutMs: number): Promise<{ abandoned: number }>;
}

/** Time to receive the request headers. */
export const HEADERS_TIMEOUT_MS = 20_000;
/** Time to receive the whole request (headers and body). Responses (an execute can run minutes) are not bounded here. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** How long an idle keep-alive connection stays open; a reverse proxy's idle timeout should be shorter. */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/** Never forwarded to the Worker: hop-by-hop headers, the Host (set from the public origin) and forwarding headers. */
const DROPPED = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "true-client-ip",
]);

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A valid IP address (IPv4-mapped IPv6 as IPv4), or undefined. */
function ipOrUndefined(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const address = plainAddress(text.trim());
  return isIP(address) === 0 ? undefined : address;
}

/**
 * The client address. Without trusted proxies, or when the peer is not one, it is the peer. From a trusted proxy:
 * X-Forwarded-For is read right to left, skipping trusted proxies, and the first other address is the client (the
 * entries left of it are client-supplied); a one-address header (X-Real-IP, CF-Connecting-IP) is taken as is. A
 * missing or malformed header falls back to the peer, so a broken proxy setup limits the proxy, never nobody.
 */
export function clientAddress(
  peer: string | undefined,
  headers: http.IncomingHttpHeaders,
  trusted: TrustedProxies | null,
  header: ClientIpHeader,
): string | undefined {
  const peerAddress = ipOrUndefined(peer);
  if (peerAddress === undefined || trusted === null || !trusted.has(peerAddress)) return peerAddress;
  const raw = headers[header];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (value === undefined || value.trim() === "") return peerAddress;
  if (header !== "x-forwarded-for") return ipOrUndefined(value) ?? peerAddress;
  const hops = value.split(",");
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = ipOrUndefined(hops[i]);
    if (hop === undefined) return peerAddress;
    if (!trusted.has(hop) || i === 0) return hop;
  }
  return peerAddress;
}

/** The request URL on the public origin, or a refusal when the target is not origin-form on that origin. */
export function requestUrl(target: string | undefined, publicBaseUrl: string): URL {
  if (target === undefined || !target.startsWith("/") || target.startsWith("//")) {
    throw new HttpRefusal(400, "Bad request target.");
  }
  let url: URL;
  try {
    url = new URL(target, publicBaseUrl);
  } catch {
    throw new HttpRefusal(400, "Bad request target.");
  }
  if (url.origin !== new URL(publicBaseUrl).origin) throw new HttpRefusal(400, "Bad request target.");
  return url;
}

/**
 * The whole body, refused with 413 once it passes `maxBytes` (at once when Content-Length says so). The rest of a
 * refused body is read and discarded rather than the socket destroyed, so the client receives the 413.
 */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) return Promise.reject(new HttpRefusal(413, "Request body too large."));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        stop();
        req.resume();
        reject(new HttpRefusal(413, "Request body too large."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      stop();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (e: Error) => {
      stop();
      reject(e);
    };
    const onClose = () => {
      stop();
      reject(new Error("the client closed the request before its body ended"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function workerHeaders(req: http.IncomingMessage, publicHost: string, client: string | undefined): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] ?? "").toLowerCase();
    if (DROPPED.has(name) || name.startsWith("cf-")) continue;
    headers.append(name, req.rawHeaders[i + 1] ?? "");
  }
  headers.set("host", publicHost);
  if (client !== undefined) headers.set("cf-connecting-ip", client);
  return headers;
}

function plain(res: http.ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra }).end(`${text}\n`);
}

async function writeResponse(res: http.ServerResponse, response: Response, closing: boolean): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  for (const [k, v] of response.headers) {
    if (k !== "set-cookie") res.setHeader(k, v);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (closing) res.setHeader("connection", "close");
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res);
}

export function createHttpFront(handler: FetchHandler, opts: HttpFrontOptions): HttpFront {
  const publicHost = new URL(opts.publicBaseUrl).host;
  const inFlight = new Set<http.ServerResponse>();
  let draining = false;
  let idle: (() => void) | undefined;

  /** The liveness answer for the container's HEALTHCHECK and the proxy: no authentication, nothing but ok and version. */
  const health = (res: http.ServerResponse, method: string): void => {
    let ok = false;
    try {
      ok = opts.healthy();
    } catch (e) {
      opts.log("warn", "health check failed", { error: e instanceof Error ? e.message : String(e) });
    }
    const body = JSON.stringify(ok ? { ok: true, version: opts.version } : { ok: false });
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(method === "HEAD" ? undefined : body);
  };

  const server = http.createServer((req, res) => {
    inFlight.add(res);
    res.on("close", () => {
      inFlight.delete(res);
      if (inFlight.size === 0) idle?.();
    });
    if (draining) {
      plain(res, 503, "Shutting down.", { connection: "close", "retry-after": "5" });
      return;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    void (async () => {
      const url = requestUrl(req.url, opts.publicBaseUrl);
      const method = req.method ?? "GET";
      if (url.pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
        health(res, method);
        return;
      }
      const hasBody = method !== "GET" && method !== "HEAD";
      const body = hasBody ? await readBody(req, opts.maxBodyBytes) : undefined;
      const client = clientAddress(req.socket.remoteAddress, req.headers, opts.trustedProxies, opts.clientIpHeader);
      const request = new Request(url, {
        method,
        headers: workerHeaders(req, publicHost, client),
        signal: abort.signal,
        ...(body === undefined ? {} : { body }),
      });
      let response: Response;
      try {
        response = await handler(request);
      } catch (e) {
        // workerd answers an uncaught exception with a 500 and logs it; so does the host, without echoing it.
        opts.log("error", "the Worker fetch threw", { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
        response = new Response("Internal Server Error", { status: 500 });
      }
      await writeResponse(res, response, draining);
    })().catch((e: unknown) => {
      if (e instanceof HttpRefusal) {
        // After a 413 the connection closes; the rest of that body is discarded.
        plain(res, e.status, e.message, e.status === 413 ? { connection: "close" } : {});
        return;
      }
      if (!abort.signal.aborted) opts.log("warn", "request failed", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) plain(res, 500, "Internal Server Error");
      else res.destroy();
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  return {
    server,
    async drain(timeoutMs: number) {
      draining = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      if (inFlight.size > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          idle = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      const abandoned = inFlight.size;
      server.closeAllConnections();
      await closed;
      return { abandoned };
    },
  };
}

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { GOOGLE_SERVICES, SERVICE_SCOPES, loadConfig, type Config, type GoogleService, type ScopePreset } from "../config";
import type { SecretSource } from "../core/ports";
import { GwsError, isGwsError } from "../errors";
import { createGoogleOAuth, type GoogleOAuth } from "../google/oauth";
import type { Transport } from "../google/transport";
import type { Redactor } from "./secrets";

/** Where Google sends the browser back. */
export const CALLBACK_PATH = "/google/callback";
/** The one-shot link the browser opener receives: it sets the flow cookie and redirects to Google. */
export const START_PATH = "/start";
/** The cookie that binds a callback to the browser that opened the start link. */
export const FLOW_COOKIE = "gws_flow";
/** The IPv4 loopback address the listener binds. Never 0.0.0.0, `::` or the name `localhost`. */
export const LOOPBACK_HOST = "127.0.0.1";
/** The IPv6 loopback, bound too by a Web client's flow: a browser may resolve `localhost` to it. */
export const LOOPBACK_HOST_V6 = "::1";
/** How long a sign-in may take before the listener closes and the flow fails. */
export const FLOW_TIMEOUT_MS = 5 * 60_000;
/** Scopes every connect asks for: the callback reads the account's identity. */
const IDENTITY_SCOPES = ["openid", "email"] as const;
const MAX_CODE = 4096;
const MAX_REQUEST_URL = 8192;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** 32 random bytes, base64url: 43 characters, used for the state and the PKCE verifier. */
export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The PKCE S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The scopes a connect asks for: identity, then each service's scopes under `preset` (all services by default). */
export function connectScopes(preset: ScopePreset, services: readonly GoogleService[] = GOOGLE_SERVICES): string[] {
  return [...new Set([...IDENTITY_SCOPES, ...services.flatMap((s) => SERVICE_SCOPES[preset][s])])];
}

/** Opens a URL in the user's browser. Injected, so tests and headless runs never open one. */
export type BrowserOpener = (url: string) => Promise<void>;

/**
 * The OS opener: `open` (macOS), `xdg-open` (Linux and others), `rundll32 url.dll,FileProtocolHandler` (Windows).
 * The URL is one argv entry, never a shell string. Resolves once the opener started; a missing opener rejects, and
 * the caller still has the printed URL.
 */
export const systemOpener: BrowserOpener = (url) =>
  new Promise((resolve, reject) => {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });


export interface LoopbackFlowOptions {
  /** The local config: upstream, fake URL and limits. Its PUBLIC_BASE_URL is replaced by the redirect origin. */
  config: Config;
  /** `desktop`: a random port on 127.0.0.1. `web`: the fixed `port` on 127.0.0.1 and [::1], redirect `http://localhost:<port>`. */
  clientType: "desktop" | "web";
  /** The Web client's fixed port; ignored for a Desktop client. */
  port: number;
  secrets: SecretSource;
  /** The upstream transport (the local ports' `http.send`), so the exchange goes where the config says. */
  send: Transport;
  /** Every token the exchange returns is remembered here, so no output can carry it. */
  redactor: Redactor;
  scopes: readonly string[];
  loginHint?: string;
  /** Opens the one-shot start link in the browser. */
  open: BrowserOpener;
  /** Told the start link when `open` failed, to print it for the user to open by hand. */
  onFallback: (startUrl: string) => void;
  /**
   * A grant the flow obtained but will not return (it ended first, or the identity read failed). The caller decides
   * whether to revoke it: revoking also ends a stored account's grant when it is the same Google account.
   */
  discard: (grant: AbandonedGrant) => Promise<void>;
  timeoutMs?: number;
  /** Test seam: called once the listeners are bound, with the port. */
  onListening?: (port: number) => void;
  /** Test seam: a bind error code to simulate for a host (`127.0.0.1` or `::1`), instead of binding it. */
  bindError?: (host: string) => string | undefined;
}

export interface LoopbackResult {
  email: string;
  sub: string;
  /** The granted set, which with `include_granted_scopes` holds the account's earlier grants too. */
  scopes: string[];
  /** Host-internal (remembered for redaction): lets the caller revoke a grant it refuses to store. */
  accessToken: string;
  refreshToken?: string;
}

/** Tokens of a grant the flow will not return, and whose account it is when that is known. */
export interface AbandonedGrant {
  accessToken: string;
  refreshToken?: string;
  sub?: string;
}

/** Why a loopback sign-in failed. Plain text; it never names a token, code or secret. */
export class LoopbackFlowError extends GwsError {
  constructor(message: string) {
    super("GWS_INTERNAL", message);
  }
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  connection: "close",
} as const;

function page(res: http.ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, PAGE_HEADERS);
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto"><h1>${title}</h1><p>${text}</p></body></html>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The value of the one cookie named `name`, or undefined when it is missing or sent more than once. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const values = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`))
    .map((p) => p.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

/** Bind errors meaning the machine has no IPv6 loopback at all: then no program can listen on [::1] either. */
const NO_IPV6_LOOPBACK: ReadonlySet<string> = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

function shownHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** A failed bind as a plain error naming the address. */
function bindFailure(host: string, port: number, code: string | undefined): LoopbackFlowError {
  return code === "EADDRINUSE"
    ? new LoopbackFlowError(`port ${port} on ${shownHost(host)} is in use. Stop the program using it, then try again`)
    : new LoopbackFlowError(`could not listen on ${shownHost(host)} for the Google redirect (${code ?? "error"})`);
}

/** Listens on host:port; rejects with the system's error (its `code` decides what the flow does). */
function listenOn(server: http.Server, host: string, port: number, injected: string | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (injected !== undefined) {
      reject(Object.assign(new Error(`simulated ${injected}`), { code: injected }));
      return;
    }
    const onError = (e: NodeJS.ErrnoException) => reject(e);
    server.once("error", onError);
    server.listen({ host, port, exclusive: true, ...(host.includes(":") ? { ipv6Only: true } : {}) }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Connects a Google account through a loopback redirect, with the user's own OAuth client:
 *
 * - A fresh `state`, PKCE verifier (S256), start nonce and browser secret per flow (32 random bytes each); the
 *   verifier and the browser secret never appear in any URL or argv.
 * - The listener binds 127.0.0.1 (a Desktop client: a random port). A Web client's flow binds its fixed port on
 *   127.0.0.1 and on [::1], since its redirect `http://localhost:<port>` may resolve to either; if either bind fails
 *   the flow does not start, so no other program can hold the other side of `localhost`. The one exception: a
 *   machine without an IPv6 loopback (EADDRNOTAVAIL, EAFNOSUPPORT) runs on 127.0.0.1 alone, as no program can hold
 *   [::1] there either.
 * - The browser opener receives only `<origin>/start?t=<nonce>`. That path answers once: it sets an HttpOnly,
 *   SameSite=Lax cookie holding the browser secret and redirects to Google. The state and challenge travel only in
 *   that redirect, inside the browser.
 * - `/google/callback` needs the Host the redirect names, GET, exactly one `state` equal to the flow's and the cookie
 *   equal to the browser secret (both compared in constant time). Anything else is refused and changes nothing; the
 *   first callback that passes claims the flow (single use).
 * - The listeners close after that callback or at the timeout (5 minutes by default), and drop open connections.
 * - The code is exchanged with the verifier; every returned token is remembered for redaction before it is used. A
 *   grant obtained after the flow ended, or whose identity cannot be read, goes to `discard` (to be revoked).
 */
export async function runLoopbackFlow(o: LoopbackFlowOptions): Promise<LoopbackResult> {
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const browserSecret = randomToken();
  const challenge = await pkceChallenge(verifier);
  const timeoutMs = o.timeoutMs ?? FLOW_TIMEOUT_MS;
  if (o.clientType === "web" && (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535)) {
    throw new LoopbackFlowError("the Web client's port must be from 1 to 65535");
  }

  const servers: http.Server[] = [];
  const closeAll = () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
  };
  const newServer = () => {
    const server = http.createServer();
    server.maxHeadersCount = 50;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    servers.push(server);
    return server;
  };
  const bind = async (host: string, port: number): Promise<void> => {
    try {
      await listenOn(newServer(), host, port, o.bindError?.(host));
    } catch (e) {
      throw Object.assign(bindFailure(host, port, (e as NodeJS.ErrnoException).code), { bindCode: (e as NodeJS.ErrnoException).code });
    }
  };
  try {
    await bind(LOOPBACK_HOST, o.clientType === "web" ? o.port : 0);
    if (o.clientType === "web") {
      try {
        await bind(LOOPBACK_HOST_V6, o.port);
      } catch (e) {
        // Without an IPv6 loopback nothing can listen on [::1], so `localhost` can only reach 127.0.0.1: carry on with
        // that listener alone. Any other failure (EADDRINUSE above all) means [::1] may be someone else's: stop.
        if (!NO_IPV6_LOOPBACK.has(String((e as { bindCode?: unknown }).bindCode))) throw e;
        const v6 = servers.pop();
        v6?.close();
      }
    }
  } catch (e) {
    closeAll();
    throw e;
  }
  const address = servers[0]?.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  o.onListening?.(port);

  const origin = o.clientType === "web" ? `http://localhost:${o.port}` : `http://${LOOPBACK_HOST}:${port}`;
  const expectedHost = new URL(origin).host;
  const startUrl = `${origin}${START_PATH}?t=${nonce}`;
  let oauth: GoogleOAuth;
  let authUrl: string;
  try {
    const flowConfig = loadConfig({ ...o.config, PUBLIC_BASE_URL: origin });
    oauth = createGoogleOAuth(flowConfig, o.secrets, o.send);
    authUrl = oauth.buildAuthUrl({
      scopes: o.scopes,
      state,
      codeChallenge: challenge,
      access: "offline",
      ...(o.loginHint !== undefined ? { loginHint: o.loginHint } : {}),
    });
  } catch (e) {
    closeAll();
    throw e;
  }

  /** The flow ended (success, failure or timeout): the listeners are closed. */
  let finished = false;
  /** The start link was used: the cookie is set in one browser and the link answers no more. */
  let started = false;
  /** A callback passed every check: the state is used up. */
  let claimed = false;
  /** The claimed callback's work, waited for at the timeout so an exchange it started is not orphaned. */
  let completing: Promise<void> | undefined;
  let settle: { resolve: (r: LoopbackResult) => void; reject: (e: unknown) => void } | undefined;
  const result = new Promise<LoopbackResult>((resolve, reject) => (settle = { resolve, reject }));
  const end = (outcome: { ok: LoopbackResult } | { error: unknown }) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    closeAll();
    if ("ok" in outcome) settle?.resolve(outcome.ok);
    else settle?.reject(outcome.error);
  };
  const timer = setTimeout(() => {
    const error = new LoopbackFlowError(`no Google sign-in arrived within ${Math.round(timeoutMs / 1000)} seconds; nothing was connected`);
    const inFlight = completing;
    if (inFlight === undefined) return end({ error });
    // An exchange is running: stop listening now, and report the timeout once its grant has been dealt with.
    finished = true;
    closeAll();
    void inFlight.finally(() => settle?.reject(error));
  }, timeoutMs);

  /** Hands a grant the flow will not return to the caller, never failing the flow over it. */
  async function abandon(grant: AbandonedGrant): Promise<void> {
    await o.discard(grant).catch(() => undefined);
  }

  /** The claimed callback: it ends the flow whatever happens next. */
  async function complete(query: URLSearchParams, res: http.ServerResponse): Promise<void> {
    if (query.has("error")) {
      page(res, 400, "Not connected", "Google did not grant access. You can close this tab.");
      end({ error: new LoopbackFlowError("Google did not grant access (the consent was declined or failed); nothing was connected") });
      return;
    }
    const codes = query.getAll("code");
    const code = codes[0];
    if (codes.length !== 1 || code === undefined || code.length === 0 || code.length > MAX_CODE) {
      page(res, 400, "Not connected", "The sign-in answer was not valid. Start again from the terminal.");
      end({ error: new LoopbackFlowError("the Google redirect carried no valid authorization code; nothing was connected") });
      return;
    }
    o.redactor.remember(code);
    let tokens;
    try {
      tokens = await oauth.exchangeCode({ code, codeVerifier: verifier });
    } catch (e) {
      page(res, 502, "Not connected", "Google did not complete the sign-in. Start again from the terminal.");
      end({ error: new LoopbackFlowError(`Google did not complete the sign-in${isGwsError(e) ? `: ${e.message}` : ""}`) });
      return;
    }
    o.redactor.remember(tokens.accessToken);
    if (tokens.refreshToken !== undefined) o.redactor.remember(tokens.refreshToken);
    const grant: AbandonedGrant = { accessToken: tokens.accessToken, ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}) };
    let who;
    try {
      who = await oauth.userinfo(tokens.accessToken);
    } catch (e) {
      page(res, 502, "Not connected", "Google did not complete the sign-in. Start again from the terminal.");
      await abandon(grant);
      end({ error: new LoopbackFlowError(`Google did not complete the sign-in${isGwsError(e) ? `: ${e.message}` : ""}`) });
      return;
    }
    if (finished) {
      // The flow timed out while this exchange ran: nobody will store the grant, so it must not stay live at Google.
      page(res, 410, "Not connected", "This sign-in took too long. Start again from the terminal.");
      await abandon({ ...grant, sub: who.sub });
      return;
    }
    page(res, 200, "Signed in", `${escapeHtml(who.email)} signed in. Return to the terminal to finish; you can close this tab.`);
    end({ ok: { email: who.email, sub: who.sub, scopes: tokens.scopes, ...grant } });
  }

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (finished || claimed) return page(res, 410, "Finished", "This sign-in has already finished. You can close this tab.");
    const host = req.headers.host;
    const rawUrl = req.url ?? "";
    // Only the exact host of the registered redirect: another name pointing here (DNS rebinding) is refused.
    if (typeof host !== "string" || host.toLowerCase() !== expectedHost) return page(res, 400, "Wrong address", "This address is not the sign-in callback.");
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.length > MAX_REQUEST_URL) return page(res, 400, "Bad request", "Not a sign-in callback.");
    const url = new URL(rawUrl, origin);
    if (url.pathname !== CALLBACK_PATH && url.pathname !== START_PATH) return page(res, 404, "Not found", "Not a sign-in callback.");
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      return page(res, 405, "Not allowed", "Not a sign-in callback.");
    }

    if (url.pathname === START_PATH) {
      const ts = url.searchParams.getAll("t");
      if (ts.length !== 1 || !sameText(ts[0] ?? "", nonce)) return page(res, 400, "Not valid", "This sign-in link is not valid. Start again from the terminal.");
      if (started) return page(res, 410, "Already used", "This sign-in link was already opened. If that was not you, stop and start again from the terminal.");
      started = true;
      res.writeHead(302, {
        location: authUrl,
        "set-cookie": `${FLOW_COOKIE}=${browserSecret}; Path=${CALLBACK_PATH}; Max-Age=${Math.ceil(timeoutMs / 1000)}; HttpOnly; SameSite=Lax`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        connection: "close",
      });
      res.end();
      return;
    }

    const states = url.searchParams.getAll("state");
    // A forged or stale callback must not end (or even disturb) the real one.
    if (states.length !== 1 || !sameText(states[0] ?? "", state)) return page(res, 400, "Not valid", "This sign-in link is not valid. Start again from the terminal.");
    // Only the browser that opened the start link holds the secret: a callback from anywhere else is refused.
    const cookie = cookieValue(req.headers.cookie, FLOW_COOKIE);
    if (!started || cookie === undefined || !sameText(cookie, browserSecret)) {
      return page(res, 400, "Not valid", "This sign-in did not start in this browser. Start again from the terminal.");
    }
    claimed = true;
    // `complete` ends the flow on every path; this only covers an unexpected throw.
    completing = complete(url.searchParams, res).catch(() => end({ error: new LoopbackFlowError("the sign-in could not be completed") }));
  }
  for (const server of servers) server.on("request", onRequest);

  try {
    await o.open(startUrl);
  } catch {
    o.onFallback(startUrl);
  }
  return result;
}

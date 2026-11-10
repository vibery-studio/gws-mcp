import { NO_ACCOUNT, appendLog, handleControl, readClock, redactQuery, takeFault } from "./control";
import { bearerOwner, googleError, handleOAuth, importSigningKey, requireAccess } from "./oauth";
import { routes as defaultRoutes, seedPresets, type FakeContext, type FakeRoute } from "./routes/index";
import type { FakeStore } from "./store";

export interface FakeGoogleOptions {
  store: FakeStore;
  /** HMAC key for authorization codes. */
  signingKey: string;
  clientId: string;
  clientSecret: string;
  /**
   * When set, `/__fake/*` requires the `x-fake-admin` header with this value. A fake with an admin token is a
   * deployed fake, so it also requires `redirectUris` and `loginSecret`.
   */
  adminToken?: string;
  /** Exact-match allowlist of OAuth redirect URIs, as registered with a real Google client. Any URI when omitted. */
  redirectUris?: readonly string[];
  /** When set, approving on the account picker requires this value in the `login_secret` password field. */
  loginSecret?: string;
  /** Service routes; defaults to every route module. */
  routes?: FakeRoute[];
}

export type FakeGoogleHandler = (req: Request) => Promise<Response>;

const MIN_ADMIN_TOKEN_LENGTH = 16;
const MIN_LOGIN_SECRET_LENGTH = 16;

/** Registered redirect URIs must be absolute http(s) URLs without a fragment, compared byte for byte later. */
function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (u.protocol === "https:" || u.protocol === "http:") && !uri.includes("#");
  } catch {
    return false;
  }
}

function validateOptions(opts: FakeGoogleOptions): void {
  if (!opts.signingKey || !opts.clientId || !opts.clientSecret) {
    throw new Error("createFakeGoogle: signingKey, clientId and clientSecret are required");
  }
  if (opts.redirectUris !== undefined && !opts.redirectUris.every(validRedirectUri)) {
    throw new Error("createFakeGoogle: redirectUris must be absolute http(s) URLs without a fragment");
  }
  if (opts.loginSecret !== undefined && opts.loginSecret.length < MIN_LOGIN_SECRET_LENGTH) {
    throw new Error(`createFakeGoogle: loginSecret must be at least ${MIN_LOGIN_SECRET_LENGTH} characters`);
  }
  if (opts.adminToken === undefined) return;
  if (opts.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`createFakeGoogle: adminToken must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  }
  if (!opts.redirectUris || opts.redirectUris.length === 0) {
    throw new Error("createFakeGoogle: redirectUris is required when adminToken is set");
  }
  if (opts.loginSecret === undefined) {
    throw new Error("createFakeGoogle: loginSecret is required when adminToken is set");
  }
}

function matchRoute(
  routes: FakeRoute[],
  method: string,
  path: string,
): { route: FakeRoute; match: RegExpExecArray } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    route.pattern.lastIndex = 0;
    const match = route.pattern.exec(path);
    if (match) return { route, match };
  }
  return undefined;
}

/**
 * A fake Google (OAuth + APIs) as a plain fetch handler. Requests use host-prefixed paths:
 * `https://gmail.googleapis.com/gmail/v1/...` is served at `/gmail.googleapis.com/gmail/v1/...`.
 * Runtime-agnostic: fetch API and Web Crypto only.
 */
export function createFakeGoogle(opts: FakeGoogleOptions): FakeGoogleHandler {
  validateOptions(opts);
  const { store } = opts;
  const redirectUris = opts.redirectUris === undefined ? undefined : new Set(opts.redirectUris);
  const routes = opts.routes ?? defaultRoutes;
  const signingKey = importSigningKey(opts.signingKey);

  async function google(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const owner = await bearerOwner(store, req);
    let logEmail: string | undefined;
    try {
      const fault = await takeFault(store, { method: req.method, path, email: owner });
      if (fault) return fault;

      const oauth = await handleOAuth(req, url, path, {
        store,
        signingKey,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        redirectUris,
        loginSecret: opts.loginSecret,
        setLogEmail: (email) => {
          logEmail = email;
        },
      });
      if (oauth) return oauth;

      const found = matchRoute(routes, req.method, path);
      if (!found) return googleError(404, `Method not found: ${req.method} ${path}`, "NOT_FOUND");
      const { route, match } = found;

      const access = await requireAccess({ req, store }, route.scopes);
      if (!access.ok) return access.response;
      const clock = await readClock(store, access.email);
      const ctx: FakeContext = {
        req,
        url,
        path,
        match,
        store,
        email: access.email,
        scopes: access.scopes,
        now: () => clock ?? Date.now(),
      };
      return await route.handle(ctx);
    } finally {
      await appendLog(store, logEmail ?? owner ?? NO_ACCOUNT, {
        ts: Date.now(),
        method: req.method,
        path,
        query: redactQuery(url.searchParams),
      });
    }
  }

  return async (req) => {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/__fake" || url.pathname.startsWith("/__fake/")) {
        return await handleControl(req, url, { store, adminToken: opts.adminToken, presets: seedPresets });
      }
      return await google(req, url);
    } catch {
      // Never echo internal errors: they could carry request material.
      return googleError(500, "Internal error in fake Google.", "INTERNAL");
    }
  };
}

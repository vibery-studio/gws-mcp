import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SERVICE_SCOPES, loadConfig, type Config } from "../config";
import { GwsError, isGwsError } from "../errors";
import { openStore, type Account, type Store } from "../store/db";
import { displayClientName, oauthApi, recordApproval } from "./clients";
import { setFlash } from "../web/flash";
import { PAGE_CSP, renderMessagePage } from "../web/ui";
import { renderConsentPage } from "./consent-page";
import { DEFAULT_NEXT, GoogleFlowError, finishGoogleAuth, revokeUnusedToken, safeNext, startGoogleAuth, type GoogleAuthResult } from "./google-flow";
import { MCP_SCOPES } from "./provider-options";
import { createSession, csrfMatches, destroySession, getSession, type AppContext } from "./session";

/** Sign-in, the Google callback, the MCP client consent page and sign-out. */
export const authRoutes = new Hono<{ Bindings: Env }>();

/** The most accounts one consent can allow (the allowlist store's own bound). */
const MAX_CHOSEN_ACCOUNTS = 100;

/** Headers of every HTML page: no framing, no caching, no script. */
function pageHeaders(c: AppContext): void {
  c.header("Content-Security-Policy", PAGE_CSP, { append: true });
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
}

async function messagePage(c: AppContext, status: ContentfulStatusCode, title: string, message: string): Promise<Response> {
  pageHeaders(c);
  return c.html(await renderMessagePage(title, message), status);
}

/** Copies headers the provider's helpers returned (binding cookies, frame-deny, Location) onto the response. */
function applyHeaders(c: AppContext, headers: Headers): void {
  for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
  headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    c.header(name, value, { append: name === "content-security-policy" });
  });
}

/** Accounts a client can be allowed to use: the user's active ones. */
function selectable(accounts: readonly Account[]): Account[] {
  return accounts.filter((a) => a.status === "active");
}

function formStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((v): v is string => typeof v === "string");
}

const FLOW_FAILURE: Record<GoogleFlowError["reason"], { status: ContentfulStatusCode; message: string }> = {
  state: { status: 400, message: "This sign-in link expired, was already used, or was opened in another browser. Start again." },
  denied: { status: 400, message: "Google sign-in was cancelled or failed. Start again." },
  code: { status: 400, message: "Google returned no authorization code. Start again." },
};

/** The account that created a user: user ids are `u_<sub of the first account used to sign in>`. */
function isPrimary(account: Account): boolean {
  return account.userId === `u_${account.sub}`;
}

/**
 * Whether a known Google account may sign in as its user. The primary account always may, whatever its
 * status: it is the user's identity, and refusing it once disconnected would lock its owner out. Sign-in
 * never revives it (status, token and scopes stay as they are). Any other account may only while active
 * and only when LOGIN_ACCOUNTS is `active`, so a disconnected secondary never signs in: anyone controlling
 * a weak secondary account (a shared mailbox, a former employer's Workspace admin) must not get the user.
 */
function maySignIn(account: Account, policy: Config["LOGIN_ACCOUNTS"]): boolean {
  if (isPrimary(account)) return true;
  return policy === "active" && account.status === "active";
}

type SignIn = { kind: "returning"; userId: string } | { kind: "new"; userId: string } | { kind: "refused" };

/**
 * The gws-mcp user behind a Google identity. Lookup is by Google `sub` only: a reissued address has a new
 * sub and must never inherit the old owner's user. A known sub signs in per `maySignIn`. A new sub becomes
 * a new user (`u_<sub>`) whose account has no token yet (`reconnect`; sign-in never stores one); an email
 * already used by another account fails with GWS_ACCOUNT_TAKEN before anything is created.
 */
async function signInUser(store: Store, config: Config, r: GoogleAuthResult): Promise<SignIn> {
  const existing = await store.accounts.findBySub(r.sub);
  if (existing) return maySignIn(existing, config.LOGIN_ACCOUNTS) ? { kind: "returning", userId: existing.userId } : { kind: "refused" };
  if (await store.accounts.emailInUse(r.email)) {
    throw new GwsError("GWS_ACCOUNT_TAKEN", "this Google account is already connected to another user");
  }
  const user = await store.users.create({ sub: r.sub, email: r.email });
  await store.accounts.upsertConnected({ userId: user.id, email: r.email, sub: r.sub, scopes: r.scopes });
  return { kind: "new", userId: user.id };
}

authRoutes.get("/login", (c) => {
  const next = safeNext(c.req.query("next"));
  return startGoogleAuth(c, { purpose: "login", scopes: ["openid", "email"], next });
});

authRoutes.get("/google/callback", async (c) => {
  let result: GoogleAuthResult;
  try {
    result = await finishGoogleAuth(c);
  } catch (e) {
    if (e instanceof GoogleFlowError) {
      const failure = FLOW_FAILURE[e.reason];
      return messagePage(c, failure.status, "Sign-in failed", failure.message);
    }
    if (isGwsError(e) && e.code === "GWS_UPSTREAM_ERROR") {
      return messagePage(c, 502, "Sign-in failed", "Google could not complete the sign-in. Start again.");
    }
    throw e;
  }

  const store = openStore(c.env);
  try {
    if (result.purpose === "login") {
      const config = loadConfig(c.env);
      const signedIn = await signInUser(store, config, result);
      if (signedIn.kind === "refused") {
        return messagePage(
          c,
          403,
          "Sign-in refused",
          "This Google account cannot be used to sign in to gws-mcp. Sign in with your primary Google account, the one you first signed in with.",
        );
      }
      // A fresh session id at every sign-in: a cookie planted before sign-in is never promoted.
      await destroySession(c);
      await createSession(c, signedIn.userId);
      if (signedIn.kind === "returning") return c.redirect(result.next, 302);
      // A new user's account has no token yet: connect it straight away (offline access, consent).
      return startGoogleAuth(c, {
        purpose: "connect",
        userId: signedIn.userId,
        scopes: Object.values(SERVICE_SCOPES[config.GOOGLE_SCOPE_PRESET]).flat(),
        loginHint: result.email,
        next: result.next,
      });
    }

    const session = await getSession(c);
    if (!session || session.userId !== result.userId) {
      // The token Google just minted will never be stored: revoke it, unless a stored token shares its grant
      // (revoking would cut that account off too). An account taken by another user is refused below and
      // never revoked, for the same reason.
      if (result.refreshToken !== undefined && !(await store.accounts.findBySub(result.sub))?.hasRefreshToken) {
        await revokeUnusedToken(c, result.refreshToken);
      }
      return messagePage(c, 403, "Connection refused", "Sign in as the user who started this connection, then start again.");
    }
    // Whether this consent added the account, read before the write (another user's sub fails the write below).
    const before = await store.accounts.findBySub(result.sub);
    const isNew = before === null;
    // The first connect of the account a first sign-in created (it holds no token yet and was never
    // disconnected, which is the only other way to lose one): first-time setup, which ends on Home.
    const firstSetup = before !== null && before.userId === session.userId && isPrimary(before) && !before.hasRefreshToken && before.status !== "disconnected";
    // Client allowlists are never touched here: a new account reaches no client until the user allows it.
    const account = await store.accounts.upsertConnected({
      userId: session.userId,
      email: result.email,
      sub: result.sub,
      scopes: result.scopes,
      ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
    });
    if (result.next !== DEFAULT_NEXT) return c.redirect(result.next, 302);
    // The result shows through a flash naming the account by id: nothing about it in the URL. First-time setup
    // lands on Home, any other connect on Google accounts.
    await setFlash(c, session.userId, { tone: "success", kind: "account-connected", accountId: account.id, isNew });
    return c.redirect(firstSetup ? "/" : "/accounts", 302);
  } catch (e) {
    if (isGwsError(e) && e.code === "GWS_ACCOUNT_TAKEN") {
      return messagePage(c, 409, "Account already in use", "This Google account is connected to another gws-mcp user.");
    }
    throw e;
  }
});

/**
 * Errors from parsing an authorization request. They redirect to the client only for a signed-in user and
 * only when the library validated the redirect URI; anyone else gets an error page, so an unauthenticated
 * link to /authorize can never bounce a browser to an arbitrary registered site.
 */
function authorizeRequestFailure(c: AppContext, e: unknown, signedIn: boolean): Promise<Response> | Response {
  if (signedIn && e instanceof AuthorizationError && e.redirectTo) return c.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
    return messagePage(c, 400, "Invalid request", "This authorization request is not valid. Start again from your app.");
  }
  throw e;
}

authRoutes.get("/authorize", async (c) => {
  const api = oauthApi(c.env);
  const session = await getSession(c);
  let request: AuthRequest;
  try {
    request = await api.parseAuthRequest(c.req.raw);
  } catch (e) {
    return authorizeRequestFailure(c, e, session !== null);
  }

  if (!session) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
  }

  const details = await api.describeConsent(request);
  const consent = await api.beginConsent(request);
  const accounts = selectable(await openStore(c.env).accounts.listForUser(session.userId));
  applyHeaders(c, consent.headers);
  pageHeaders(c);
  const page = await renderConsentPage({
    clientName: displayClientName(details.clientName, request.clientId),
    redirectHost: details.redirectHost,
    redirectIsLoopback: details.redirectIsLoopback,
    scope: details.scope,
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      ...(a.alias !== undefined ? { alias: a.alias } : {}),
      isDefault: a.isDefault,
    })),
    handle: consent.handle,
    csrf: session.csrf,
  });
  return c.html(page, 200);
});

authRoutes.post("/authorize", async (c) => {
  const session = await getSession(c);
  if (!session) return messagePage(c, 401, "Signed out", "Your session ended. Start again from your app.");
  const form = await c.req.parseBody({ all: true });
  if (!csrfMatches(session, form.csrf)) {
    return messagePage(c, 403, "Request refused", "This form did not come from this site. Start again from your app.");
  }
  const handle = typeof form.handle === "string" ? form.handle : "";
  const api = oauthApi(c.env);
  const store = openStore(c.env);

  try {
    if (form.decision !== "approve") {
      const denied = await api.denyConsent(c.req.raw, handle);
      applyHeaders(c, denied.headers);
      return c.body(null, 302);
    }

    // Checked before the handle is consumed, so a corrected submission of the same page still works.
    const chosen = [...new Set(formStrings(form.account))];
    const owned = new Set(selectable(await store.accounts.listForUser(session.userId)).map((a) => a.id));
    if (chosen.length > MAX_CHOSEN_ACCOUNTS || !chosen.every((id) => owned.has(id))) {
      return messagePage(c, 400, "Invalid choice", "Choose only accounts listed on the page.");
    }

    // The request (client, redirect URI, PKCE) comes from server-side storage, never from the form.
    const approved = await api.approveConsent(c.req.raw, handle, { scope: [...MCP_SCOPES] });
    const clientId = approved.request.clientId;
    const clientName = displayClientName((await api.lookupClient(clientId))?.clientName, clientId);
    const { redirectTo } = await api.completeAuthorization({
      request: approved.request,
      userId: session.userId,
      metadata: { clientName },
      scope: approved.request.scope,
      props: { userId: session.userId, clientId },
    });
    // Recorded in D1 before the code can reach the client, so /connections and revoke see this grant at once.
    await recordApproval(c.env, { userId: session.userId, clientId, clientName, redirectTo });
    // Exactly the accounts chosen on this page. If either write fails, the code never reaches the client.
    await store.grants.replace(session.userId, clientId, chosen);
    applyHeaders(c, approved.headers);
    return c.redirect(redirectTo, 302);
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return messagePage(c, 400, "Consent expired", "This page expired, was already used, or was opened in another browser. Start again from your app.");
    }
    throw e;
  }
});

authRoutes.post("/logout", async (c) => {
  const session = await getSession(c);
  if (session) {
    const form = await c.req.parseBody();
    if (!csrfMatches(session, form.csrf)) {
      return messagePage(c, 403, "Request refused", "This form did not come from this site.");
    }
  }
  await destroySession(c);
  return messagePage(c, 200, "Signed out", "You are signed out of gws-mcp.");
});

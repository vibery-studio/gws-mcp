import { Hono } from "hono";
import { getClient, oauthApi, revokeClient, type ClientSummary } from "../auth/clients";
import { DEFAULT_NEXT, startGoogleAuth } from "../auth/google-flow";
import { getSession, type AppContext } from "../auth/session";
import { GOOGLE_SERVICES, SERVICE_SCOPES, grantedServices, loadConfig, type GoogleService } from "../config";
import { CONFIRM_GRANT_PATH, CONNECT_START_PATH, peekGrantRequest, revokeAndWipe, takeConnectRequest, takeGrantRequest } from "../core/accounts-capability";
import { APPROVAL_LINK_PATH } from "../core/human-approval";
import { SETTING_LINK_PATH } from "../core/setting-links";
import { isGwsError } from "../errors";
import { googleOAuth } from "../google/oauth";
import { createTransport } from "../google/transport";
import { openStore, type Account, type Store } from "../store/db";
import { invalidate } from "../store/token-cache";
import { renderConfirmGrantPage, type PageAccount, type PageClient } from "./connections-page";
import { setFlash, type Flash } from "./flash";
import { boundedId, field, fields, guardPost, messagePage, pageHeaders, posted, requireSignedIn, toLogin } from "./http";
import { accessPage, addAccessRule, removeAccessRule } from "./pages/access";
import { accountDetailsPage, removeAdsCode, saveAccountName, saveAdsDetails } from "./pages/account-details";
import { accountDisconnectPage } from "./pages/account-disconnect";
import { accountReconnectPage } from "./pages/account-reconnect";
import { accountServicesPage, addAccountServices } from "./pages/account-services";
import { accountsPage } from "./pages/accounts";
import { approvalLinkPage, decideFromApprovalLink } from "./pages/approval-link";
import { appDetailsPage, saveAppAccess } from "./pages/app-details";
import { appRemovePage } from "./pages/app-remove";
import { appsPage } from "./pages/apps";
import { homePage } from "./pages/home";
import { saveSettingFromLink, settingLinkPage } from "./pages/setting-link";

/**
 * The signed-in human's pages and actions: Home, Google accounts, AI apps, the grant confirmation and the
 * connect flow start. Every page but Home needs a session (else sign-in, coming back there). Every POST
 * needs the session, this site's Origin and the session's CSRF token (`guardPost`), and every account or
 * app id it names must belong to the session's user. Actions here are the human's own, so they apply
 * directly; the only way an AI app's `accounts.grant` request becomes a grant is the confirmation POST below.
 * After an action, the browser is redirected (303) to the page that shows its result, with a flash.
 *
 * Page handlers live in their modules under ./pages; this file registers every route once.
 */
export const connectionsRoutes = new Hono<{ Bindings: Env }>();

type Ctx = AppContext;

/** Every POST under these paths passes `guardPost` first. A new POST endpoint must live under one of them. */
export const GUARDED_POST_PATHS = ["/connections/*", "/accounts/*", "/apps/*", "/access/*", SETTING_LINK_PATH, APPROVAL_LINK_PATH] as const;
/** Every GET under these paths needs a session (Home handles signed-out visitors itself). */
const SIGNED_IN_PAGES = ["/accounts/*", "/apps/*", "/access"] as const;

function oauthClient(env: Env) {
  return googleOAuth(env, createTransport(env, loadConfig(env)));
}

/** The connect flow's scopes for `services` under the configured preset (startGoogleAuth adds openid email). */
function connectScopes(env: Env, services: readonly GoogleService[]): string[] {
  const preset = SERVICE_SCOPES[loadConfig(env).GOOGLE_SCOPE_PRESET];
  return [...new Set(services.flatMap((s) => preset[s]))];
}

function pageAccount(env: Env, a: Account): PageAccount {
  return {
    id: a.id,
    email: a.email,
    ...(a.alias !== undefined ? { alias: a.alias } : {}),
    isDefault: a.isDefault,
    status: a.status,
    scopes: a.scopes,
    services: grantedServices(loadConfig(env).GOOGLE_SCOPE_PRESET, a.scopes),
  };
}

/** The hosts a client sends access to, from its registered redirect URIs. */
async function redirectHosts(env: Env, clientId: string): Promise<string[]> {
  const client = await oauthApi(env).lookupClient(clientId);
  const hosts = new Set<string>();
  for (const uri of client?.redirectUris ?? []) {
    try {
      hosts.add(new URL(uri).host);
    } catch {
      // A malformed registered URI shows nothing rather than failing the page.
    }
  }
  return [...hosts];
}

async function pageClient(env: Env, c: ClientSummary): Promise<PageClient> {
  return { clientId: c.clientId, name: c.clientName, redirectHosts: await redirectHosts(env, c.clientId), approvedAt: c.approvedAt, allowed: c.accountIds };
}

/** The account `id` of the session's user, or null (another user's, or none). */
async function ownAccount(store: Store, userId: string, id: string | undefined): Promise<Account | null> {
  const bounded = boundedId(id);
  return bounded === undefined ? null : store.accounts.get(userId, bounded);
}

/** The session user's approved client `id` (a recorded approval), or null. */
async function ownClient(env: Env, userId: string, id: string | undefined): Promise<ClientSummary | null> {
  const bounded = boundedId(id);
  return bounded === undefined ? null : getClient(env, userId, bounded);
}

const forbidden = (c: Ctx) => messagePage(c, 403, "Request refused", "That is not one of your Google accounts or AI apps.");

/** Post/redirect/get: the result page, with a flash for the session's user. */
async function doneAt(c: Ctx, location: string, flash: Flash): Promise<Response> {
  await setFlash(c, posted(c).session.userId, flash);
  return c.redirect(location, 303);
}

const accountPath = (id: string) => `/accounts/${encodeURIComponent(id)}`;
const appPath = (id: string) => `/apps/${encodeURIComponent(id)}`;

// ---- Gates ------------------------------------------------------------------------------------------

connectionsRoutes.on("GET", [...SIGNED_IN_PAGES], requireSignedIn);
connectionsRoutes.on("POST", [...GUARDED_POST_PATHS], guardPost);

// ---- Pages ------------------------------------------------------------------------------------------

connectionsRoutes.get("/", homePage);
connectionsRoutes.get("/accounts", accountsPage);
connectionsRoutes.get("/accounts/:id", accountDetailsPage);
connectionsRoutes.get("/accounts/:id/services", accountServicesPage);
connectionsRoutes.get("/accounts/:id/reconnect", accountReconnectPage);
connectionsRoutes.get("/accounts/:id/disconnect", accountDisconnectPage);
connectionsRoutes.get("/apps", appsPage);
connectionsRoutes.get("/apps/:id", appDetailsPage);
connectionsRoutes.get("/apps/:id/remove", appRemovePage);
// Admins only; the handlers check the role themselves.
connectionsRoutes.get("/access", accessPage);

/** The old management page: its accounts now live under /accounts and its apps under /apps. Nothing from the query is kept. */
connectionsRoutes.get("/connections", (c) => c.redirect("/accounts", 303));

connectionsRoutes.get(CONFIRM_GRANT_PATH, async (c) => {
  const session = await getSession(c);
  if (!session) return toLogin(c);
  const token = c.req.query("t");
  // Read, not consumed: only the confirmation POST consumes the request.
  const request = await peekGrantRequest(c.env.CACHE_KV, token, session.userId);
  const client = request ? await ownClient(c.env, session.userId, request.clientId) : null;
  if (!request || !client || token === undefined) {
    return messagePage(c, 400, "Link not valid", "This link expired, was already used, is not for you, or its app is no longer approved. Ask the app again.");
  }
  const allowed = new Set(client.accountIds);
  const accounts = await openStore(c.env).accounts.listForUser(session.userId);
  pageHeaders(c);
  return c.html(
    await renderConfirmGrantPage({
      csrf: session.csrf,
      token,
      client: await pageClient(c.env, client),
      ...(request.hint !== undefined ? { hint: request.hint } : {}),
      choices: accounts.filter((a) => a.status === "active" && !allowed.has(a.id)).map((a) => pageAccount(c.env, a)),
    }),
  );
});

connectionsRoutes.get(CONNECT_START_PATH, async (c) => {
  const session = await getSession(c);
  // Checked before the link is read, so signing in first does not use it up.
  if (!session) return toLogin(c);
  const request = await takeConnectRequest(c.env.CACHE_KV, c.req.query("t"), session.userId);
  if (!request) {
    return messagePage(c, 400, "Link not valid", "This connect link expired, was already used, or belongs to another user. Ask the app for a new one.");
  }
  // Only a login hint for Google's account chooser, and only when it names one of this user's accounts.
  const hint = c.req.query("hint")?.trim().toLowerCase();
  const own = hint ? (await openStore(c.env).accounts.listForUser(session.userId)).find((a) => a.email === hint) : undefined;
  return startGoogleAuth(c, {
    purpose: "connect",
    userId: session.userId,
    scopes: connectScopes(c.env, request.services),
    ...(own ? { loginHint: own.email } : {}),
    next: DEFAULT_NEXT,
  });
});

// The one-time setting link: the page checks the session itself (signed out, it signs in and comes back).
connectionsRoutes.get(SETTING_LINK_PATH, settingLinkPage);
connectionsRoutes.post(SETTING_LINK_PATH, saveSettingFromLink);
// The approval link of a plan whose steps need the person's approval: same session rules as the setting link.
connectionsRoutes.get(APPROVAL_LINK_PATH, approvalLinkPage);
connectionsRoutes.post(APPROVAL_LINK_PATH, decideFromApprovalLink);

// ---- New page actions (handlers in their page modules) ----------------------------------------------

connectionsRoutes.post("/accounts/:id/name", saveAccountName);
connectionsRoutes.post("/accounts/:id/ads", saveAdsDetails);
connectionsRoutes.post("/accounts/:id/ads/remove", removeAdsCode);
connectionsRoutes.post("/accounts/:id/services", addAccountServices);
connectionsRoutes.post("/apps/:id/access", saveAppAccess);
connectionsRoutes.post("/access/add", addAccessRule);
connectionsRoutes.post("/access/remove", removeAccessRule);

// ---- Actions (field names are a contract: the E2E harness and older pages post them) ---------------

connectionsRoutes.post("/connections/connect", async (c) => {
  const { userId } = posted(c).session;
  const form = posted(c).form;
  const requested = fields(form, "service");
  const services = [...new Set(requested)].filter((s): s is GoogleService => (GOOGLE_SERVICES as readonly string[]).includes(s));
  if (services.length === 0 || services.length !== new Set(requested).size) {
    return messagePage(c, 400, "Choose Google services", "Choose at least one of the listed Google services.");
  }
  let loginHint: string | undefined;
  const accountId = field(form, "account");
  if (accountId !== undefined) {
    const account = await ownAccount(openStore(c.env), userId, accountId);
    if (!account) return forbidden(c);
    loginHint = account.email;
  }
  return startGoogleAuth(c, {
    purpose: "connect",
    userId,
    scopes: connectScopes(c.env, services),
    ...(loginHint ? { loginHint } : {}),
    next: DEFAULT_NEXT,
  });
});

connectionsRoutes.post("/connections/disconnect", async (c) => {
  const { userId } = posted(c).session;
  const store = openStore(c.env);
  const account = await ownAccount(store, userId, field(posted(c).form, "account"));
  if (!account) return forbidden(c);
  try {
    await revokeAndWipe({ store, oauth: oauthClient(c.env), invalidateToken: (id) => invalidate(c.env, id) }, userId, account.id);
  } catch (e) {
    if (isGwsError(e) && e.code === "GWS_UPSTREAM_ERROR") {
      return messagePage(c, 502, "Disconnect failed", "Google could not remove access right now, so nothing was changed. Try again.");
    }
    throw e;
  }
  return doneAt(c, "/accounts", { tone: "success", kind: "account-disconnected", accountId: account.id });
});

connectionsRoutes.post("/connections/set-default", async (c) => {
  const { userId } = posted(c).session;
  const store = openStore(c.env);
  const account = await ownAccount(store, userId, field(posted(c).form, "account"));
  if (!account) return forbidden(c);
  if (account.status === "disconnected") return messagePage(c, 400, "Not connected", "Connect this account again before making it the default.");
  await store.accounts.setDefault(userId, account.id);
  return doneAt(c, accountPath(account.id), { tone: "success", kind: "default-set", accountId: account.id });
});

connectionsRoutes.post("/connections/alias", async (c) => {
  const { userId } = posted(c).session;
  const form = posted(c).form;
  const store = openStore(c.env);
  const account = await ownAccount(store, userId, field(form, "account"));
  if (!account) return forbidden(c);
  const alias = field(form, "alias")?.trim() ?? "";
  try {
    await store.accounts.setAlias(userId, account.id, alias === "" ? null : alias);
  } catch (e) {
    if (isGwsError(e) && e.code === "GWS_INVALID_INPUT") {
      return messagePage(c, 400, "Account name not saved", "Use up to 64 characters without @, not already used by another of your accounts.");
    }
    throw e;
  }
  return doneAt(c, accountPath(account.id), { tone: "success", kind: "account-renamed", accountId: account.id });
});

/** The session user's client and account named by the form, or a refusal response. */
async function clientAndAccount(c: Ctx): Promise<{ client: ClientSummary; account: Account } | Response> {
  const { userId } = posted(c).session;
  const form = posted(c).form;
  const [client, account] = await Promise.all([ownClient(c.env, userId, field(form, "client")), ownAccount(openStore(c.env), userId, field(form, "account"))]);
  if (!client || !account) return forbidden(c);
  return { client, account };
}

connectionsRoutes.post("/connections/client-grant", async (c) => {
  const target = await clientAndAccount(c);
  if (target instanceof Response) return target;
  // Only active accounts. A disconnected account keeps its rows only until it is reconnected, which clears
  // them; a grant now would be one more row on an account the user cannot use yet.
  if (target.account.status !== "active") return messagePage(c, 400, "Not connected", "Only connected accounts can be allowed.");
  await openStore(c.env).grants.add(posted(c).session.userId, target.client.clientId, target.account.id);
  return doneAt(c, appPath(target.client.clientId), { tone: "success", kind: "app-access-saved", appId: target.client.clientId });
});

connectionsRoutes.post("/connections/client-ungrant", async (c) => {
  const target = await clientAndAccount(c);
  if (target instanceof Response) return target;
  await openStore(c.env).grants.remove(posted(c).session.userId, target.client.clientId, target.account.id);
  return doneAt(c, appPath(target.client.clientId), { tone: "success", kind: "app-access-saved", appId: target.client.clientId });
});

connectionsRoutes.post("/connections/client-revoke", async (c) => {
  const { userId } = posted(c).session;
  const client = await ownClient(c.env, userId, field(posted(c).form, "client"));
  if (!client) return forbidden(c);
  await revokeClient(c.env, userId, client.clientId);
  return doneAt(c, "/apps", { tone: "success", kind: "app-removed", appName: client.clientName });
});

connectionsRoutes.post("/connections/confirm-grant", async (c) => {
  const { userId } = posted(c).session;
  const form = posted(c).form;
  const store = openStore(c.env);
  const decision = field(form, "decision");
  if (decision !== "allow" && decision !== "deny") return messagePage(c, 400, "Choose", "Choose Allow or Decline.");
  const allow = decision === "allow";
  let account: Account | null = null;
  if (allow) {
    // Checked before the link is consumed, so a corrected submission of the same page still works.
    account = await ownAccount(store, userId, field(form, "account"));
    if (!account) return forbidden(c);
    if (account.status !== "active") return messagePage(c, 400, "Not connected", "Only connected accounts can be allowed.");
  }
  const request = await takeGrantRequest(c.env.CACHE_KV, field(form, "t"), userId);
  if (!request) return messagePage(c, 400, "Link not valid", "This link expired, was already used, or is not for you. Ask the app again.");
  if (!account) return doneAt(c, "/apps", { tone: "success", kind: "app-request-declined", appId: request.clientId });
  // The grant goes only to the client that asked, and only while the user still approves that client.
  const client = await ownClient(c.env, userId, request.clientId);
  if (!client) return messagePage(c, 400, "App not approved", "This app is no longer approved. Connect it again from the app first.");
  await store.grants.add(userId, client.clientId, account.id);
  return doneAt(c, appPath(client.clientId), { tone: "success", kind: "app-access-saved", appId: client.clientId });
});

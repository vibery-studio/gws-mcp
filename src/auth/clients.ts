import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { GwsError } from "../errors";
import { openStore, type ClientApproval, type StoreEnv } from "../store/db";

/** The provider's helpers. OAuthProvider adds them to the env of every request it hands the web app. */
export function oauthApi(env: Env): OAuthHelpers {
  const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
  if (!helpers) throw new GwsError("GWS_INTERNAL", "OAuth provider helpers are not available");
  return helpers;
}

/** The most characters of a client name shown anywhere. */
export const MAX_CLIENT_NAME = 100;
/** Control and format characters: C0/C1 controls, bidi embeddings, overrides, isolates and marks, zero-width characters. */
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;

/**
 * A self-asserted client name made safe to display: without control or bidi characters (which can
 * reorder or hide text, e.g. U+202E), trimmed, capped at MAX_CLIENT_NAME characters, and `fallback`
 * (the client id) when nothing is left. It still needs HTML escaping.
 */
export function displayClientName(name: string | undefined, fallback: string): string {
  const chars = Array.from((name ?? "").replace(HIDDEN_CHARS, "").trim());
  if (chars.length === 0) return fallback;
  return chars.length > MAX_CLIENT_NAME ? `${chars.slice(0, MAX_CLIENT_NAME).join("")}…` : chars.join("");
}

/** An MCP client the user approved, with its account allowlist. */
export interface ClientSummary {
  clientId: string;
  /** Self-asserted at registration, passed through `displayClientName`: still escape it wherever it is rendered. */
  clientName: string;
  /** Account ids in this client's allowlist. */
  accountIds: string[];
  /** Epoch seconds of the latest approval. */
  approvedAt: number;
}

/** The grant ids the provider lists for the user's client. Eventually consistent on Cloudflare (a KV list). */
async function listedGrantIds(api: OAuthHelpers, userId: string, clientId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listUserGrants(userId, cursor === undefined ? undefined : { cursor });
    for (const g of page.items) if (g.clientId === clientId) ids.push(g.id);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return ids;
}

/** Grant ids in the provider's alphabet (letters, digits, `-`, `_`). */
const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The grant id of a credential the provider issued to `userId`, or null. The provider (workers-oauth-provider
 * 1.2.4) returns no grant id from `completeAuthorization` and puts none on the request's verified `ctx.auth`;
 * its authorization codes and access tokens are `<userId>:<grantId>:<secret>`, and it looks a token up by
 * exactly those first two parts. Used by consent (the code) and the MCP request check (the bearer token).
 */
export function grantIdOfCredential(credential: string, userId: string): string | null {
  const parts = credential.split(":");
  const grantId = parts[1];
  return parts.length === 3 && parts[0] === userId && grantId !== undefined && GRANT_ID.test(grantId) ? grantId : null;
}

/**
 * The grant id inside the authorization code that `completeAuthorization` put in `redirectTo`. Anything
 * else fails, so an unrecorded grant's code never reaches the client.
 */
export function grantIdOfRedirect(redirectTo: string, userId: string): string {
  let code: string | null = null;
  try {
    code = new URL(redirectTo).searchParams.get("code");
  } catch {
    // Reported below as an unexpected redirect.
  }
  const grantId = code === null ? null : grantIdOfCredential(code, userId);
  if (grantId === null) throw new GwsError("GWS_INTERNAL", "the authorization redirect carries no recognizable grant");
  return grantId;
}

/**
 * Whether the bearer token's grant has a recorded approval of exactly this user and client. A revoke deletes
 * the rows in D1 (strongly consistent), so it takes effect here at once, even when the provider's own grant
 * revocation missed a just-issued token through its eventually consistent token listing.
 */
export async function isGrantApproved(env: StoreEnv, verified: { token: string; userId: string; clientId: string }): Promise<boolean> {
  const grantId = grantIdOfCredential(verified.token, verified.userId);
  return grantId !== null && openStore(env).approvals.has(verified.userId, verified.clientId, grantId);
}

/**
 * Records a consent's new grant, then retires the client's earlier grants for this user. Call it after
 * `completeAuthorization` and before its redirect is sent, so every grant that can mint a token has a row.
 *
 * `completeAuthorization` replaces the user's earlier grants of the client (revokeExistingGrants defaults to
 * true; with Client ID Metadata Documents off that is every grant of the client id), but it finds them
 * through its eventually consistent grant listing and so can miss one approved moments ago. The recorded
 * ones are revoked here too. That is best-effort, as in the provider: a grant that fails to revoke keeps its
 * row, so the next client revoke still revokes it, and its tokens act with the same allowlist as the new one.
 */
export async function recordApproval(
  env: Env,
  approval: { userId: string; clientId: string; clientName: string; redirectTo: string },
): Promise<void> {
  const { userId, clientId } = approval;
  const grantId = grantIdOfRedirect(approval.redirectTo, userId);
  const store = openStore(env);
  await store.approvals.record({ userId, clientId, grantId, clientName: approval.clientName });
  // Only rows older than this one, in the rows' (created_at, grant_id) order: a concurrent consent's newer row
  // stays, so of two interleaved consents the later one wins instead of each retiring the other. A row gone
  // already (a revoke ran in between) leaves nothing to retire.
  const recorded = await store.approvals.grantIds(userId, clientId);
  const mine = recorded.indexOf(grantId);
  const earlier = mine < 0 ? [] : recorded.slice(0, mine);
  if (earlier.length === 0) return;
  const api = oauthApi(env);
  const outcomes = await Promise.allSettled(earlier.map((id) => api.revokeGrant(id, userId)));
  await store.approvals.remove(
    userId,
    clientId,
    earlier.filter((_, i) => outcomes[i]?.status === "fulfilled"),
  );
}

async function summary(store: ReturnType<typeof openStore>, userId: string, a: ClientApproval): Promise<ClientSummary> {
  return {
    clientId: a.clientId,
    clientName: a.clientName,
    accountIds: await store.grants.list(userId, a.clientId),
    approvedAt: Math.floor(a.approvedAt / 1000),
  };
}

/** The user's approved MCP clients (recorded approvals in D1), each with its name and account allowlist. */
export async function listClients(env: Env, userId: string): Promise<ClientSummary[]> {
  const store = openStore(env);
  return Promise.all((await store.approvals.list(userId)).map((a) => summary(store, userId, a)));
}

/** The user's approved client `clientId` with its allowlist, or null when the user has not approved it. */
export async function getClient(env: Env, userId: string, clientId: string): Promise<ClientSummary | null> {
  const store = openStore(env);
  const approval = await store.approvals.get(userId, clientId);
  return approval ? summary(store, userId, approval) : null;
}

/**
 * Revokes a client for the user, in an order where a failure at any step leaves the client reaching no
 * account: first its account allowlist (D1, checked on every call), then every grant (and so every access
 * and refresh token) recorded for it, plus any the provider lists that were never recorded, then the
 * recorded rows. Until the rows go, the client stays listed, so a failed revoke can be retried. Other users'
 * grants of the same client are untouched.
 */
export async function revokeClient(env: Env, userId: string, clientId: string): Promise<void> {
  const api = oauthApi(env);
  const store = openStore(env);
  await store.grants.removeClient(userId, clientId);
  const recorded = await store.approvals.grantIds(userId, clientId);
  const listed = await listedGrantIds(api, userId, clientId);
  for (const grantId of new Set([...recorded, ...listed])) await api.revokeGrant(grantId, userId);
  await store.approvals.remove(userId, clientId, recorded);
}

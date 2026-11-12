import type { AccessRuleView } from "../contracts";
import type { AccessPort } from "../core/access-capability";
import { openAccessStore, type AccessChange, type AccessRole, type AccessRule } from "../store/access";
import type { StoreEnv } from "../store/db";
import { oauthApi } from "./clients";

/**
 * Enforcement of the access allowlist on the remote server. Sign-in admits only allowed emails (`admitSignIn`); every
 * MCP request and every signed-in page rechecks the user's role (`userRole`), cached per isolate for at most
 * `ACCESS_CACHE_MS`; removing a rule also ends the shut-out users' AI app access at once (`removeRuleAndRevoke`).
 * The local runtime (one user, stdio) has the table but enforces none of this.
 */

/** The longest a role read is reused within one isolate. */
export const ACCESS_CACHE_MS = 60_000;
/** Entries kept per isolate; the cache is cleared when it would grow past this. */
const MAX_CACHED_USERS = 1000;

const cache = new Map<string, { role: AccessRole | null; until: number }>();

/** Drops every cached role in this isolate (after a change made here, so this isolate sees it at once). */
export function forgetAccessCache(): void {
  cache.clear();
}

/**
 * The user's role, or null when no rule allows the user (or the user does not exist). Cached per isolate and user
 * for at most `ACCESS_CACHE_MS`, so another isolate's removal takes effect here within that window. A failed lookup
 * throws and is never cached: callers deny on a throw.
 */
export async function userRole(env: Pick<StoreEnv, "DB">, userId: string, now = Date.now()): Promise<AccessRole | null> {
  const hit = cache.get(userId);
  if (hit && hit.until > now && hit.until - now <= ACCESS_CACHE_MS) return hit.role;
  const role = await openAccessStore(env.DB).roleForUser(userId);
  if (cache.size >= MAX_CACHED_USERS) cache.clear();
  cache.set(userId, { role, until: now + ACCESS_CACHE_MS });
  return role;
}

/** `userRole`, with any failure read as "not allowed": the fail-closed form for gates. */
export async function userRoleOrNull(env: Pick<StoreEnv, "DB">, userId: string, now = Date.now()): Promise<AccessRole | null> {
  try {
    return await userRole(env, userId, now);
  } catch {
    return null;
  }
}

/**
 * Whether a Google sign-in may proceed. The identity checked is the user's own sign-in email: for a returning user the
 * address the user was created with (`users.primary_email`, whichever of their accounts signs in now), for a new user
 * the Google email. On an empty allowlist exactly that identity first becomes the admin (one conditional insert, so
 * only one of two concurrent first sign-ins can), so the person who bootstraps is always the person admitted. A user
 * whose rule was removed cannot come back through another of their accounts.
 */
export async function admitSignIn(
  env: Pick<StoreEnv, "DB">,
  signIn: { email: string; userId: string; existingUser: boolean; mayBootstrap?: boolean },
): Promise<boolean> {
  const access = openAccessStore(env.DB);
  const identity = signIn.existingUser ? await primaryEmailOf(env, signIn.userId) : signIn.email;
  if (identity === null) return false;
  if (signIn.mayBootstrap !== false && (await access.bootstrap(identity, signIn.userId))) forgetAccessCache();
  return (await access.roleFor(identity)) !== null;
}

async function primaryEmailOf(env: Pick<StoreEnv, "DB">, userId: string): Promise<string | null> {
  const u = await env.DB.prepare("SELECT primary_email FROM users WHERE id = ?").bind(userId).first<{ primary_email: string }>();
  return u?.primary_email ?? null;
}

/** What a removal did beyond the rule itself. */
export interface RemovalResult {
  removed: AccessRule | null;
  /** Users the removal shut out. */
  usersShutOut: number;
  /** AI apps cut off: their approvals and account allowlists were deleted with the rule, so their tokens are refused. */
  appsEnded: number;
  /**
   * Provider grants (or a user's grant listing) that could not be revoked or read. Those tokens are refused anyway,
   * since their approval rows are gone, but the cleanup did not finish.
   */
  appsFailed: number;
}

/** The provider's grant ids for the user, all clients. */
async function listedGrantIds(api: ReturnType<typeof oauthApi>, userId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listUserGrants(userId, cursor === undefined ? undefined : { cursor });
    for (const g of page.items) ids.push(g.id);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return ids;
}

/**
 * Removes a rule. The store deletes, in the same transaction, every AI app approval and account allowlist row of each
 * user it shuts out: that is the kill switch (`isGrantApproved` refuses their tokens for good, and re-adding the user
 * revives none). Only then are the provider grants revoked, best-effort, from the recorded ids plus the provider's
 * own listing; anything that fails is counted in `appsFailed`, and the rule removal stands.
 */
export async function removeRuleAndRevoke(env: Env, pattern: unknown, change: AccessChange): Promise<RemovalResult> {
  const removed = await openAccessStore(env.DB).remove(pattern, change);
  forgetAccessCache();
  if (!removed) return { removed: null, usersShutOut: 0, appsEnded: 0, appsFailed: 0 };
  let appsEnded = 0;
  let appsFailed = 0;
  for (const user of removed.shutOut) {
    appsEnded += user.clients;
    const ids = new Set(user.grantIds);
    try {
      for (const id of await listedGrantIds(oauthApi(env), user.userId)) ids.add(id);
    } catch {
      appsFailed++;
    }
    for (const id of ids) {
      try {
        await oauthApi(env).revokeGrant(id, user.userId);
      } catch {
        appsFailed++;
      }
    }
  }
  return { removed: removed.rule, usersShutOut: removed.shutOut.length, appsEnded, appsFailed };
}

/** Adds a rule or sets its role (see the access store's `add`); this isolate sees the change at once. */
export async function addRule(
  env: Pick<StoreEnv, "DB">,
  input: { pattern: unknown; role: unknown; note?: unknown },
  change: AccessChange,
): ReturnType<ReturnType<typeof openAccessStore>["add"]> {
  try {
    return await openAccessStore(env.DB).add(input, change);
  } finally {
    forgetAccessCache();
  }
}

function view(rule: AccessRule): AccessRuleView {
  const v: AccessRuleView = { pattern: rule.pattern, kind: rule.kind, role: rule.role, createdAt: rule.createdAt };
  if (rule.note !== undefined) v.note = rule.note;
  return v;
}

/** The Workers adapter of the core's access port, for `access.*` fns (changes are recorded as made through the SDK). */
export function workersAccessPort(env: Env): AccessPort {
  const store = openAccessStore(env.DB);
  return {
    roleOf: (userId) => store.roleForUser(userId),
    list: async () => (await store.list()).map(view),
    add: async (input, actor) => {
      const r = await addRule(env, input, { actor, via: "sdk" });
      return { outcome: r.outcome, rule: view(r.rule) };
    },
    remove: async (pattern, actor) => {
      const r = await removeRuleAndRevoke(env, pattern, { actor, via: "sdk" });
      return { ...r, removed: r.removed === null ? null : view(r.removed) };
    },
  };
}

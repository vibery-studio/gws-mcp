import { z } from "zod";
import { GOOGLE_SERVICES, type Config, type GoogleService } from "../config";
import type { AccountList, AccountView, AccountsCapability, AuthProps, CapabilityWrite, PlanStep, StepId, UserLink } from "../contracts";
import { GwsError, isGwsError } from "../errors";
import type { GoogleOAuth } from "../google/oauth";
import { isDestructive } from "./destructive";
import type { Account, AccountStatus, AccountStore, ApprovalPort, LinkStore } from "./ports";

const MAX_REF = 320;
const MAX_ALIAS = 64;

/** Path of the /connections page that lets the user confirm a client's grant request. */
export const CONFIRM_GRANT_PATH = "/connections/confirm";
/** Path that starts Google consent from a connect link. */
export const CONNECT_START_PATH = "/connect/start";
/** Life of a grant or connect link. */
export const LINK_TTL_MS = 10 * 60_000;

/**
 * The one denial for every account a client may not use: not in its allowlist, another user's, made up, in
 * reconnect state, or a missing default. It echoes only the caller's own ref, so it reveals nothing about
 * which accounts exist.
 */
export function accountDenied(ref: string | undefined): GwsError {
  const account = ref === undefined || ref.trim() === "" ? "default" : ref.slice(0, MAX_REF);
  return new GwsError("GWS_ACCOUNT_DENIED", "this account is not connected or not allowed for this client; the user can allow it on /connections", {
    details: { account },
  });
}

/**
 * The error for an account that must be reconnected before use. Only for callers allowed to know the account
 * (it echoes the email). Reconnecting a disconnected account clears its client allowlist rows, so for one the
 * text also says the user must allow it for the client again.
 */
export function reconnectRequired(account: { email: string; status: AccountStatus }): GwsError {
  const message =
    account.status === "disconnected"
      ? "this account was disconnected; after the user reconnects it on /connections, they must allow it for this client again"
      : "this account must be reconnected";
  return new GwsError("GWS_RECONNECT_REQUIRED", message, { account: account.email });
}

function invalidArg(path: string, message: string): GwsError {
  return new GwsError("GWS_INVALID_INPUT", message, { details: { issues: [{ path, message }] } });
}

function refArg(ref: unknown, path: string): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref !== "string" || ref.length > MAX_REF) throw invalidArg(path, "account must be an email or alias");
  return ref;
}

// ---- Single-use links -------------------------------------------------------------------------------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HINT_RE = /^[^\s\p{Cc}]{1,320}$/u;

const GrantRequest = z.strictObject({
  kind: z.literal("grant"),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  hint: z.string().regex(HINT_RE).optional(),
  exp: z.number(),
});
const ConnectRequest = z.strictObject({
  kind: z.literal("connect"),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  services: z.array(z.enum(GOOGLE_SERVICES)).min(1).max(GOOGLE_SERVICES.length),
  exp: z.number(),
});
export type GrantRequest = z.output<typeof GrantRequest>;
export type ConnectRequest = z.output<typeof ConnectRequest>;
type LinkRecord = GrantRequest | ConnectRequest;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Key of a link record: only a hash of the token is stored, so the stored records are not usable links. */
async function linkKey(kind: LinkRecord["kind"], token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return `req:${kind}:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function putLink(kv: LinkStore, record: LinkRecord, baseUrl: string, path: string): Promise<UserLink> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await kv.put(await linkKey(record.kind, token), JSON.stringify(record), { expirationTtl: Math.ceil(LINK_TTL_MS / 1000) });
  return { url: `${baseUrl}${path}?t=${token}`, expiresAt: record.exp };
}

/**
 * Consumes a link token: the record is deleted on first presentation, whoever presents it, and returned
 * only to the user it was issued to, before it expires. KV is eventually consistent across locations, so a
 * replay within KV's propagation delay elsewhere is possible; consumers must keep the resulting action
 * idempotent and bound to the record's user and client.
 */
async function takeLink<T extends LinkRecord>(
  kv: LinkStore,
  kind: T["kind"],
  schema: z.ZodType<T>,
  token: unknown,
  userId: string,
  now: number,
  consume = true,
): Promise<T | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const key = await linkKey(kind, token);
  const raw = await kv.get(key);
  if (raw === null) return null;
  if (consume) {
    try {
      await kv.delete(key);
    } catch (e) {
      // An adapter whose take is atomic (the local SQLite store) rejects the delete when another caller took the
      // record first: for this caller there is no record. KV never rejects this way, so Workers is unchanged.
      if (isGwsError(e) && e.code === "GWS_INVALID_INPUT") return null;
      throw e;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = schema.safeParse(parsed);
  if (!r.success || r.data.userId !== userId || r.data.exp <= now) return null;
  return r.data;
}

/** For the /connections confirmation endpoint: the grant request behind `token`, for the signed-in `userId`. */
export function takeGrantRequest(kv: LinkStore, token: unknown, userId: string, now = Date.now()): Promise<GrantRequest | null> {
  return takeLink(kv, "grant", GrantRequest, token, userId, now);
}

/**
 * For the /connections confirmation page: the grant request behind `token`, for the signed-in `userId`,
 * WITHOUT consuming it, so the page can show which client asks. Only `takeGrantRequest`, on the human's
 * CSRF-checked confirmation, may lead to a grant.
 */
export function peekGrantRequest(kv: LinkStore, token: unknown, userId: string, now = Date.now()): Promise<GrantRequest | null> {
  return takeLink(kv, "grant", GrantRequest, token, userId, now, false);
}

/** For /connect/start: the connect request behind `token`, for the signed-in `userId`. */
export function takeConnectRequest(kv: LinkStore, token: unknown, userId: string, now = Date.now()): Promise<ConnectRequest | null> {
  return takeLink(kv, "connect", ConnectRequest, token, userId, now);
}

// ---- Disconnect -------------------------------------------------------------------------------------

/** What a disconnect needs, from a client session (`ctx.accounts`) or from the signed-in human (/connections). */
export interface RevokeDeps {
  /** Any store whose `accounts` can read the token for the revoke and wipe it (the full Store qualifies). */
  store: { readonly accounts: Pick<AccountStore, "getRefreshTokenForRevoke" | "wipeToken"> };
  /** OAuth client for the revoke at Google. */
  oauth: GoogleOAuth;
  /** Runs the upstream revoke; a client session passes its upstream limits. Direct when omitted. */
  upstream?<T>(fn: () => Promise<T>): Promise<T>;
  /** Drops an account's cached access token. */
  invalidateToken(accountId: string): Promise<void>;
}

/**
 * Disconnects one of `userId`'s accounts: revokes the Google grant, then deletes the token and scopes. Client
 * allowlist rows are kept, so an allowlisted client is told to reconnect; the consent that brings the account
 * back clears them, so reconnecting restores no client's access. Revoke first: if Google refuses, nothing is
 * wiped and the user can retry. An account in reconnect state may still hold a token whose grant Google
 * honours, so any stored token is revoked; Google counts an already invalid one as revoked. The caller checks
 * that the account is the caller's to disconnect.
 */
export async function revokeAndWipe(deps: RevokeDeps, userId: string, accountId: string): Promise<void> {
  const refreshToken = await deps.store.accounts.getRefreshTokenForRevoke(userId, accountId);
  if (refreshToken !== null) {
    const revoke = () => deps.oauth.revoke(refreshToken);
    await (deps.upstream ? deps.upstream(revoke) : revoke());
  }
  await deps.store.accounts.wipeToken(userId, accountId);
  // Best effort: a cached access token is unusable anyway once the account is disconnected (the token
  // cache serves only active accounts of the same token generation).
  await deps.invalidateToken(accountId).catch(() => undefined);
}

// ---- Capability -------------------------------------------------------------------------------------

/** The stores the capability uses: the accounts and the client allowlists (the full D1 Store qualifies). */
export interface CapabilityStore {
  readonly accounts: AccountStore;
  readonly grants: ApprovalPort;
}

/** What the dispatcher hands the capability. Host fns never see any of it, only the resulting methods. */
export interface AccountsCapabilityDeps {
  store: CapabilityStore;
  auth: AuthProps;
  apply: boolean;
  config: Pick<Config, "PUBLIC_BASE_URL">;
  /** Holds the single-use link records. */
  kv: LinkStore;
  /** OAuth client for the revoke on disconnect. */
  oauth: GoogleOAuth;
  /** Runs an upstream call under the session's upstream limits. */
  upstream<T>(fn: () => Promise<T>): Promise<T>;
  /** Drops an account's cached access token. */
  invalidateToken(accountId: string): Promise<void>;
  now(): number;
  /** Records a dry-run plan step for the calling fn. */
  plan(step: Omit<PlanStep, "step">): StepId;
  /** Marks the calling fn as having changed state under apply. */
  applied(accountId: string | null, destructive: boolean): void;
}

function view(a: Account): AccountView {
  const v: AccountView = { email: a.email, isDefault: a.isDefault, scopes: [...a.scopes], status: a.status === "active" ? "active" : "reconnect" };
  if (a.alias !== undefined) v.alias = a.alias;
  return v;
}

/** Same reference rules as the store's `resolve`: empty means the default, "@" means an email, else an alias. */
function find(all: readonly Account[], ref: string | undefined): Account | undefined {
  const r = ref?.trim() ?? "";
  if (r === "") return all.find((a) => a.isDefault);
  const key = r.toLowerCase();
  return all.find((a) => (r.includes("@") ? a.email === key : a.alias === key));
}

/** Builds the `ctx.accounts` capability for one `accounts.*` call. See `AccountsCapability` for the rules. */
export function createAccountsCapability(deps: AccountsCapabilityDeps): AccountsCapability {
  const { store, auth, apply } = deps;
  const { userId, clientId } = auth;

  async function state(): Promise<{ all: Account[]; allowed: ReadonlySet<string> }> {
    const [all, allowed] = await Promise.all([store.accounts.listForUser(userId), store.grants.list(userId, clientId)]);
    return { all, allowed: new Set(allowed) };
  }

  /**
   * The account `ref` names, only when it is in the calling client's allowlist; else the uniform denial. A
   * disconnected account keeps its rows until it is reconnected: it is listed (as needing reconnect) and can be
   * dropped from this client's allowlist, but `connected` refuses it for anything else, with the reconnect
   * error only this allowlisted client gets.
   */
  async function target(ref: string | undefined, connected: boolean) {
    const s = await state();
    const account = find(s.all, ref);
    if (!account || !s.allowed.has(account.id)) throw accountDenied(ref);
    if (connected && account.status === "disconnected") throw reconnectRequired(account);
    return { account, ...s };
  }

  async function write<T>(fn: string, account: Account | undefined, note: string | undefined, run: () => Promise<T>): Promise<CapabilityWrite<T>> {
    const { destructive } = isDestructive(fn);
    if (!apply) {
      const step: Omit<PlanStep, "step"> = { fn, effect: "write", destructive };
      if (account) step.account = account.email;
      if (note) step.note = note;
      return { applied: false, step: deps.plan(step) };
    }
    deps.applied(account?.id ?? null, destructive);
    return { applied: true, value: await run() };
  }

  const link = (record: LinkRecord, path: string) => putLink(deps.kv, record, deps.config.PUBLIC_BASE_URL, path);

  const capability: AccountsCapability = {
    async list(): Promise<AccountList> {
      const { all, allowed } = await state();
      const accounts = all.filter((a) => allowed.has(a.id)).map(view);
      return { accounts, hiddenCount: all.length - accounts.length };
    },

    async get(ref) {
      return view((await target(refArg(ref, "account"), false)).account);
    },

    async connectUrl(services) {
      const parsed = z.array(z.enum(GOOGLE_SERVICES)).min(1).max(GOOGLE_SERVICES.length).safeParse(services);
      if (!parsed.success) throw invalidArg("services", `services must be some of ${GOOGLE_SERVICES.join(", ")}`);
      const unique: GoogleService[] = [...new Set(parsed.data)];
      return link({ kind: "connect", userId, clientId, services: unique, exp: deps.now() + LINK_TTL_MS }, CONNECT_START_PATH);
    },

    async setAlias(ref, alias) {
      if (alias !== null && (typeof alias !== "string" || alias.length > MAX_ALIAS)) throw invalidArg("alias", "alias must be a string or null");
      const { account } = await target(refArg(ref, "account") ?? "", true);
      return write("accounts.alias", account, undefined, async () => view(await store.accounts.setAlias(userId, account.id, alias)));
    },

    async setDefault(ref) {
      const { account, all, allowed } = await target(refArg(ref, "account") ?? "", true);
      // The default applies to every client of the user: moving it off an account this client cannot use would
      // redirect another client's default-account calls.
      const current = all.find((a) => a.isDefault);
      if (current && current.id !== account.id && !allowed.has(current.id)) throw accountDenied(undefined);
      return write("accounts.setDefault", account, undefined, async () => view(await store.accounts.setDefault(userId, account.id)));
    },

    async disconnect(ref) {
      const { account } = await target(refArg(ref, "account") ?? "", true);
      return write("accounts.disconnect", account, undefined, async () => {
        await revokeAndWipe(deps, userId, account.id);
        return { email: account.email };
      });
    },

    async requestGrant(hint) {
      if (hint !== undefined && (typeof hint !== "string" || !HINT_RE.test(hint))) throw invalidArg("hint", "hint must be an email or alias");
      const note = "returns a /connections link; only the user's confirmation there adds the grant";
      return write("accounts.grant", undefined, note, () => {
        const record: GrantRequest = { kind: "grant", userId, clientId, exp: deps.now() + LINK_TTL_MS };
        if (hint !== undefined) record.hint = hint;
        return link(record, CONFIRM_GRANT_PATH);
      });
    },

    async ungrant(ref) {
      const { account } = await target(refArg(ref, "account") ?? "", false);
      return write("accounts.ungrant", account, undefined, async () => {
        await store.grants.remove(userId, clientId, account.id);
        return { email: account.email };
      });
    },
  };
  return Object.freeze(capability);
}

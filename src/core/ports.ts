import type { Config, SecretName } from "../config";
import type { AuditRow } from "../contracts";
import type { Transport } from "../google/transport";
import type { UserSettingsPort } from "./settings-capability";

export type { UserSettingsPort };

/**
 * The ports the platform-free core depends on. Each runtime (Workers, local Node) supplies adapters; nothing in
 * the core reaches a platform binding, an env object or a platform type directly. Members are property
 * signatures on purpose: under `strictFunctionTypes` their parameters are checked contravariantly, so an
 * adapter cannot quietly accept less than the core passes.
 */

// ---- Accounts -----------------------------------------------------------------------------------------

export type AccountStatus = "active" | "reconnect" | "disconnected";

/**
 * A connected Google account as the rest of the server sees it. Never carries token material.
 * Read it from the store (`resolve`, `get`, `findBySub`, `listForUser`) within the call that uses it and never
 * cache it across calls: its `status` and `tokenGeneration` are what gate access-token use.
 */
export interface Account {
  id: string;
  userId: string;
  email: string;
  sub: string;
  alias?: string;
  isDefault: boolean;
  scopes: string[];
  status: AccountStatus;
  hasRefreshToken: boolean;
  /**
   * Opaque marker of the stored refresh token: it changes whenever a new one is stored and is null
   * without one. The token cache binds entries to it, so an entry minted under an earlier token is
   * never served after a disconnect and reconnect. Not secret (the ciphertext's random IV), but
   * host-internal: never render it.
   */
  tokenGeneration: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A user's connected accounts, their encrypted refresh tokens, the default and the aliases. Every method is
 * scoped to `userId`: another user's account is indistinguishable from an unknown one.
 */
export interface AccountStore {
  /**
   * Resolves an email or alias among the user's own accounts, or the default when `ref` is empty. Fails with
   * GWS_NO_DEFAULT_ACCOUNT, GWS_ACCOUNT_UNKNOWN, or GWS_RECONNECT_REQUIRED for an account that is not active.
   */
  readonly resolve: (userId: string, ref?: string) => Promise<Account>;
  readonly listForUser: (userId: string) => Promise<Account[]>;
  /** Sets or clears (null) an alias. Aliases are lowercased, unique per user and never contain "@". */
  readonly setAlias: (userId: string, accountId: string, alias: string | null) => Promise<Account>;
  readonly setDefault: (userId: string, accountId: string) => Promise<Account>;
  /**
   * Decrypts the stored refresh token whatever the account's status, or null when none is stored. Only the
   * disconnect flow may use it, to revoke the Google grant before the token is wiped.
   */
  readonly getRefreshTokenForRevoke: (userId: string, accountId: string) => Promise<string | null>;
  /** Deletes the refresh token and scopes and marks the account `disconnected`; allowlist rows are kept. */
  readonly wipeToken: (userId: string, accountId: string) => Promise<Account>;
}

/**
 * The per-client account allowlists. Remote enforces them (a human grants each account to each MCP client);
 * the local runtime has one user and no client approval layer, so its adapter allows every account.
 */
export interface ApprovalPort {
  readonly isAllowed: (userId: string, clientId: string, accountId: string) => Promise<boolean>;
  /** The ids of the accounts in the client's allowlist. */
  readonly list: (userId: string, clientId: string) => Promise<string[]>;
  /** Removes one account from the client's allowlist. There is deliberately no way to add one here. */
  readonly remove: (userId: string, clientId: string, accountId: string) => Promise<void>;
}

/** Short-lived Google access tokens, minted from the stored refresh tokens. */
export interface TokenCache {
  /**
   * A usable access token for `account`, which must come from the AccountStore in the same call. Fails with
   * GWS_RECONNECT_REQUIRED for an account that is not active or whose grant was revoked. Host-internal: the
   * token must never reach a snippet, log or error.
   */
  readonly getAccessToken: (account: Account) => Promise<string>;
  /** Drops the cached access token of an account. */
  readonly invalidate: (accountId: string) => Promise<void>;
}

/** Records of single-use links (connect and grant requests), keyed by a hash of the link token. */
export interface LinkStore {
  readonly get: (key: string) => Promise<string | null>;
  /** `expirationTtl` in seconds; the record must be gone (or unreadable) after it. */
  readonly put: (key: string, value: string, opts: { expirationTtl: number }) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

// ---- Limits, audit, secrets, HTTP -----------------------------------------------------------------------

/** Writes one execute's audit rows. Metadata only. */
export interface AuditSink {
  /** Writes all rows atomically: on failure none is written. */
  readonly insertMany: (rows: readonly AuditRow[]) => Promise<void>;
}

/** Fixed-window counters behind the per-user and per-client rate limits. */
export interface RateCounter {
  /** Counts one hit in the window starting at `windowStart` and returns the window's new count. */
  readonly hit: (key: string, windowStart: number) => Promise<number>;
}

/**
 * The runtime's secrets. Read only when needed (lazily), so a value is touched only by the code that uses it;
 * never logged or echoed. Undefined when a secret is not set.
 */
export interface SecretSource {
  readonly get: (name: SecretName) => string | undefined;
}

/** The single upstream HTTP seam. Every Google request (API and OAuth) goes out through `send`. */
export interface HttpPort {
  /**
   * The upstream `send` targets. The OAuth client picks its credentials by the session config's upstream, so a
   * session refuses ports whose upstream differs: the real client secret must never be sent to the fake.
   */
  readonly upstream: Config["GOOGLE_UPSTREAM"];
  readonly send: Transport;
}

// ---- Sandbox --------------------------------------------------------------------------------------------

/** The host side of `__gws.call`: one SDK call from the sandbox. */
export type SandboxCall = (name: unknown, input: unknown) => Promise<unknown>;

export interface SandboxLimits {
  /** Wall-clock limit of the run. The core also stops waiting shortly after it, whatever the sandbox does. */
  timeoutMs: number;
  /** CPU time the snippet may use. */
  cpuMs: number;
  /**
   * Memory the snippet may use. An adapter that cannot enforce a limit this low must refuse the run (throw a
   * GwsError), never run with a higher one.
   */
  memoryBytes: number;
}

export interface SandboxRequest {
  /** Source of an async arrow function (normalized and wrapped by the core); it returns JSON text or undefined. */
  code: string;
  /** Sandbox-side JavaScript run before `code`; it builds `sdk` over `__gws.call`. */
  prelude: string;
  /**
   * The only host function the sandbox can reach, exposed inside as `__gws.call(name, input)`. It never throws.
   * Nothing else crosses: no network, env, binding, module loader or host global.
   */
  call: SandboxCall;
  limits: SandboxLimits;
}

/**
 * How a run ended. `result` and `logs` come from the snippet and are untrusted: the core validates their types.
 * `limit` is set when a limit ended the run rather than the snippet.
 */
export interface SandboxResult {
  result?: unknown;
  /** The message the snippet ended with, or the sandbox's own failure (a syntax error, say). */
  error?: unknown;
  logs?: unknown;
  limit?: "wall" | "cpu";
  /**
   * SDK calls the sandbox itself refused before they reached `call` (a cap on what may cross into the host), as wire
   * errors in the order they were refused. When the snippet ends with one of them, the core reports it as it would
   * an error the dispatcher returned.
   */
  refusals?: unknown;
}

/** Runs one snippet in a fresh, isolated sandbox. */
export interface SandboxPort {
  /** Turns a snippet as the client sent it into the source of an async arrow function. */
  readonly normalize: (code: string) => string;
  /** Resolves with how the run ended; rejects only when the sandbox itself failed. */
  readonly run: (req: SandboxRequest) => Promise<SandboxResult>;
}

// ---- Composition ----------------------------------------------------------------------------------------

/** Everything one call session needs from its runtime. */
export interface SessionPorts {
  readonly accounts: AccountStore;
  readonly approval: ApprovalPort;
  readonly tokens: TokenCache;
  readonly links: LinkStore;
  readonly audit: AuditSink;
  readonly rate: RateCounter;
  readonly secrets: SecretSource;
  readonly http: HttpPort;
  /** The users' encrypted settings (the Google Ads developer token and login customer id). */
  readonly userSettings: UserSettingsPort;
}

/** Everything one execute needs from its runtime. */
export interface CorePorts extends SessionPorts {
  readonly sandbox: SandboxPort;
}

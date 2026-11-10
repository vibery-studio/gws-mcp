import type { ZodType } from "zod";
import type { Config, GoogleService, SecretName as ConfigSecretName } from "./config";
import type { GwsErrorCode, WireError } from "./errors";

export type Effect = "read" | "write";

export type FnService = GoogleService | "helpers" | "accounts";

/** Plan step id: "s1", "s2", ... in call order within one execute. */
export type StepId = `s${number}`;

/**
 * Secrets (Worker secret bindings remotely: wrangler `secrets.required`). Only the credential store and the
 * auth glue read them, through the runtime's SecretSource; host fns never see them. The Workers runtime checks
 * at compile time that each one is a binding of its env (src/runtime/workers/env.ts).
 */
export const SECRET_NAMES = ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const satisfies readonly ConfigSecretName[];
export type SecretName = (typeof SECRET_NAMES)[number];

/** Prefix of the string a pending (unexecuted) write result stringifies to inside the sandbox. */
export const PENDING_TOKEN_PREFIX = "__gws_pending__:";

/** HTTP shape of one Google method, emitted by the SDK generator from the pinned Discovery docs. */
export interface MethodMeta {
  /** Discovery method id, e.g. "gmail.users.messages.list". */
  id: string;
  service: GoogleService;
  httpMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  rootUrl: string;
  servicePath: string;
  /** Discovery path template, e.g. "gmail/v1/users/{userId}/messages". */
  path: string;
  /** `reserved` is true for `{+name}` expansion (keeps "/"). */
  pathParams: Array<{ name: string; reserved: boolean }>;
  queryParams: Array<{ name: string; repeated: boolean }>;
  requestBody: boolean;
  mediaUpload?: { multipartPath: string; simplePath: string; accept: string[]; maxBytes: number };
  mediaDownload: boolean;
  scopes: string[];
  effect: Effect;
}

/** What `search` sees and returns for one SDK function. */
export interface FnMeta {
  /** Dotted SDK name as called in snippets, e.g. "gmail.users.messages.list". */
  name: string;
  service: FnService;
  effect: Effect;
  description: string;
  /** Compact one-line TypeScript signature. */
  signature: string;
  /** Full TypeScript declaration (input and output types). */
  tsDecl: string;
  example: string;
  tags: string[];
  scopes: string[];
}

/** One registered SDK function. Google fns carry `method`; host fns carry `run`. */
export interface FnDef<I = unknown, O = unknown> extends FnMeta {
  kind: "google" | "host";
  input: ZodType<I>;
  output: ZodType<O>;
  method?: MethodMeta;
  // Method syntax on purpose: keeps FnDef<Specific> assignable to FnDef (bivariant parameters).
  run?(input: I, ctx: CallCtx): Promise<O>;
}

/** Props stored with an MCP access token by `completeAuthorization`. */
export interface AuthProps {
  userId: string;
  clientId: string;
}

/** A connected Google account after resolution and allowlist checks. Never carries tokens. */
export interface ResolvedAccount {
  id: string;
  email: string;
  alias?: string;
  scopes: string[];
}

/**
 * The only config values host fns see: an explicit allowlist of non-secret values. Everything else (the
 * upstream mode, the fake's URL, secrets, bindings) stays with the dispatcher.
 */
export const HOST_CONFIG_KEYS = ["PUBLIC_BASE_URL", "GOOGLE_SCOPE_PRESET", "CALL_RESPONSE_MAX_BYTES"] as const satisfies readonly (keyof Config)[];
export type HostConfig = Pick<Config, (typeof HOST_CONFIG_KEYS)[number]>;

/** A connected account as a client may see it: only accounts in its allowlist, never ids or token state. */
export interface AccountView {
  email: string;
  alias?: string;
  isDefault: boolean;
  scopes: string[];
  status: "active" | "reconnect";
}

export interface AccountList {
  /** The accounts in the calling client's allowlist. */
  accounts: AccountView[];
  /** How many other accounts the user has; the user manages them on /connections. */
  hiddenCount: number;
}

/** A single-use link the user opens in their browser. */
export interface UserLink {
  url: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** A capability write: planned (dry-run) or applied. */
export type CapabilityWrite<T> = { applied: false; step: StepId } | { applied: true; value: T };

/**
 * Store-backed account operations for `accounts.*` fns only, bound to the session's user and client. No
 * method takes a user, client or account id: accounts are named by email or alias (the default when
 * omitted) and every target must be in the calling client's allowlist, else GWS_ACCOUNT_DENIED, the same
 * error whether or not the account exists. Nothing here can add to an allowlist. Writes plan a step in
 * dry-run and change nothing; they run only under apply.
 */
export interface AccountsCapability {
  /** Read. */
  list(): Promise<AccountList>;
  /** Read. */
  get(ref?: string): Promise<AccountView>;
  /**
   * Read: a single-use link (10 min) that starts Google consent for `services` as the calling user. It
   * never touches an allowlist: a newly connected account is not granted to any client.
   */
  connectUrl(services: readonly GoogleService[]): Promise<UserLink>;
  /** Write. Sets or clears (null) the alias of an allowlisted account. */
  setAlias(ref: string, alias: string | null): Promise<CapabilityWrite<AccountView>>;
  /** Write. Both the new default and the current default (when set) must be allowlisted: it affects every client. */
  setDefault(ref: string): Promise<CapabilityWrite<AccountView>>;
  /** Destructive write. Revokes the Google grant and deletes the token; allowlist rows are kept until a reconnect clears them. */
  disconnect(ref: string): Promise<CapabilityWrite<{ email: string }>>;
  /**
   * Write: a single-use /connections confirmation link bound to the calling user and client. Only the
   * user's confirmation on that page adds a grant; this never does. `hint` (an email or alias, no
   * whitespace) is shown to the user as a suggestion.
   */
  requestGrant(hint?: string): Promise<CapabilityWrite<UserLink>>;
  /** Write. Removes an account from the calling client's allowlist only. */
  ungrant(ref: string): Promise<CapabilityWrite<{ email: string }>>;
}

/** Per-call context handed to host fns. No env, binding, secret or raw upstream handle: only capabilities. */
export interface CallCtx {
  apply: boolean;
  auth: AuthProps;
  account?: ResolvedAccount;
  config: HostConfig;
  executeId: string;
  /** Re-enters the dispatcher: budget, guard, audit and limits apply to nested calls too. */
  call(fnName: string, input: unknown): Promise<unknown>;
  /** Records a host-fn plan step (dry-run) and returns its id. */
  planStep(step: Omit<PlanStep, "step">): StepId;
  /** Resolves an account reference (email or alias, default when omitted) and enforces the client allowlist. */
  resolveAllowed(ref?: string): Promise<ResolvedAccount>;
  /** Present only for `accounts.*` fns. */
  accounts?: AccountsCapability;
}

export interface PlanRequest {
  method: string;
  url: string;
  query: Record<string, string | string[]>;
  body?: unknown;
}

export interface PlanStep {
  step: StepId;
  fn: string;
  account?: string;
  effect: Effect;
  destructive: boolean;
  request?: PlanRequest;
  /** True when the step depends on the result of an unexecuted write. */
  incomplete?: boolean;
  dependsOn?: StepId[];
  note?: string;
}

export type CallStatus = "ok" | "error" | "planned" | "denied";

export interface CallRecord {
  seq: number;
  fn: string;
  account?: string;
  effect: Effect;
  status: CallStatus;
  code?: GwsErrorCode;
  ms: number;
}

export interface ExecuteOutput {
  ok: boolean;
  executeId: string;
  applied: boolean;
  destructive: boolean;
  result?: unknown;
  error?: WireError;
  logs: string[];
  calls: CallRecord[];
  plan: PlanStep[];
}

/** One row of `audit_log`. Metadata only: never bodies, file contents or tokens. */
export interface AuditRow {
  id: string;
  ts: number;
  execute_id: string;
  user_id: string;
  client_id: string;
  account_id: string | null;
  fn: string;
  effect: Effect;
  applied: 0 | 1;
  status: CallStatus;
  code: GwsErrorCode | null;
  duration_ms: number;
  request_id: string | null;
  upstream_status: number | null;
}

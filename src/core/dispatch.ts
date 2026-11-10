import type { Config } from "../config";
import {
  HOST_CONFIG_KEYS,
  PENDING_TOKEN_PREFIX,
  type AuthProps,
  type CallCtx,
  type CallRecord,
  type CallStatus,
  type FnDef,
  type HostConfig,
  type MethodMeta,
  type PlanRequest,
  type PlanStep,
  type ResolvedAccount,
  type StepId,
} from "../contracts";
import { GwsError, isGwsError, toWire, type GwsErrorCode, type WireError } from "../errors";
import { callGoogle } from "../google/client";
import { createGoogleOAuth } from "../google/oauth";
import { buildRequest, describeRequest } from "../google/request";
import type { Transport } from "../google/transport";
import { accountDenied, createAccountsCapability } from "./accounts-capability";
import { AuditBuffer } from "./audit";
import { isDestructive } from "./destructive";
import { CallBudget, UpstreamLimits, approxJsonBytes, capBytes, checkInputSize, checkRate, isBinary } from "./limits";
import type { Account, SessionPorts } from "./ports";
import { getRegistry, type Registry } from "./registry";

/** Audit and call-record name for a call whose name is not a registered fn: snippet text is never recorded. */
export const UNKNOWN_FN = "<unknown>";

const INCOMPLETE_NOTE = "depends on unexecuted write";
const MAX_ISSUES = 5;
const MAX_ISSUE_TEXT = 200;
/** A planned request body above this many bytes is stored as its size only, so the plan stays small. */
const PLAN_BODY_MAX_BYTES = 16_000;
/**
 * Errors kept per session for matching the error a snippet ends with. Past this, only the first error of each code
 * is still kept, so the list stays bounded however many calls fail.
 */
const MAX_KEPT_ERRORS = 64;

/** What one SDK call returns to the sandbox. Never thrown: errors are values. */
export type DispatchResult = { ok: true; value: unknown } | { __gwsPending: StepId } | { __gwsError: WireError };

export interface CallSessionOptions {
  /** The runtime's ports. Only the dispatcher's own paths use them; host fns get no port, only capabilities. */
  ports: SessionPorts;
  auth: AuthProps;
  apply: boolean;
  executeId: string;
  config: Config;
  /** Functions callable in this session; the SDK registry when omitted. */
  registry?: Registry;
  /** Clock for timestamps, durations and rate windows. */
  now?: () => number;
}

export interface CloseOptions {
  /** How long to wait for in-flight calls; `EXECUTE_TIMEOUT_MS` when omitted. */
  waitMs?: number;
}

export interface CallSession {
  /** The single entry for every SDK call, top-level or nested. Always resolves; never throws. */
  dispatch(fnName: unknown, input: unknown): Promise<DispatchResult>;
  /** Planned steps in order: dry-run writes, incomplete steps and host-fn steps. */
  readonly plan: readonly PlanStep[];
  /** One record per call, in completion order (`seq` is the start order). */
  readonly calls: readonly CallRecord[];
  /** True when any plan step is destructive. */
  readonly destructive: boolean;
  /** True when a destructive call was actually sent upstream (or a destructive capability write ran) under apply. */
  readonly appliedDestructive: boolean;
  /** Calls refused for the spent budget that have no audit row (only the first refusal is audited). */
  readonly unauditedRefusals: number;
  /** The most recent error returned by any call. */
  readonly lastError: WireError | undefined;
  /**
   * Errors calls returned while the snippet could still see them (before `close`), in the order they were returned:
   * the first MAX_KEPT_ERRORS, plus the first of each code after that. Errors caused by the end of the execute (a
   * queued call that `close` released, a call refused after it) are not among them, so they can never stand in for
   * the error the snippet threw.
   */
  readonly errors: readonly WireError[];
  /** Writes the buffered audit rows in one batch. Throws GWS_INTERNAL when the write fails. */
  flush(): Promise<void>;
  /**
   * Ends the session: refuses new calls with GWS_EXECUTION_ERROR (nested calls of a host fn still running
   * are let through), releases the calls queued for an upstream slot with the same error, waits for the calls
   * in flight, records any still running after `waitMs` as
   * GWS_EXECUTION_TIMEOUT, then flushes the audit. Call it in a `finally` around every execute, so an
   * un-awaited or timed-out applied write still gets its row. Idempotent; after a failed flush it retries.
   */
  close(opts?: CloseOptions): Promise<void>;
}

/** Codes that mean the host refused the call by grant or limit policy. */
const DENIED_CODES: ReadonlySet<GwsErrorCode> = new Set([
  "GWS_ACCOUNT_DENIED",
  "GWS_SCOPE_MISSING",
  "GWS_RATE_LIMITED",
  "GWS_CALL_BUDGET_EXCEEDED",
]);

const PENDING_STEP = /__gws_pending__:(s[1-9][0-9]{0,8})/g;

/** What one call did, for its call record and audit row. */
interface Trace {
  accountId: string | null;
  /** Set only once the client is allowed to use the account. */
  accountEmail?: string;
  applied: boolean;
  upstreamStatus: number | null;
  planned: boolean;
}

/** A started call that has no call record or audit row yet. */
interface CallEntry {
  seq: number;
  label: string;
  effect: "read" | "write";
  started: number;
  trace: Trace;
  recorded: boolean;
}

/** A host fn call while it runs: its nested calls are part of it, also while the session is closing. */
interface HostScope {
  active: boolean;
  trace: Trace;
}

type Ran = { kind: "pending"; id: StepId } | { kind: "value"; status: "ok" | "planned"; value: unknown };

function safeWire(e: unknown): WireError {
  try {
    return toWire(e);
  } catch {
    return { code: "GWS_INTERNAL", message: "internal error" };
  }
}

function fromWire(w: WireError): GwsError {
  const opts: { details?: Record<string, unknown>; fn?: string; account?: string } = {};
  if (w.details !== undefined) opts.details = w.details;
  if (w.fn !== undefined) opts.fn = w.fn;
  if (w.account !== undefined) opts.account = w.account;
  return new GwsError(w.code, w.message, opts);
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === "symbol" ? p.toString() : String(p))).join(".").slice(0, MAX_ISSUE_TEXT);
}

type Issue = { path: PropertyKey[]; message: string; code?: string; keys?: string[] };

function invalidInput(def: FnDef, issues: readonly Issue[]): GwsError {
  const shown = issues.slice(0, MAX_ISSUES).map((i) => ({ path: issuePath(i.path), message: i.message.slice(0, MAX_ISSUE_TEXT) }));
  return new GwsError("GWS_INVALID_INPUT", `invalid input for ${def.name}`, { details: { issues: shown } });
}

function parseInput(def: FnDef, input: unknown): unknown {
  const r = def.input.safeParse(input);
  if (r.success) return r.data;
  throw invalidInput(def, r.error.issues as Issue[]);
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let v = value;
  for (const key of path) {
    if (typeof v !== "object" || v === null || typeof key === "symbol") return undefined;
    v = (v as Record<string, unknown>)[String(key)];
  }
  return v;
}

/** True when a validation issue is caused by a pending token: a dependent value is checked when it exists. */
function explainedByPending(input: unknown, issue: Issue): boolean {
  const at = valueAt(input, issue.path);
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys ?? [];
    return keys.length > 0 && keys.every((k) => pendingDeps(k) !== undefined || pendingDeps(valueAt(at, [k])) !== undefined);
  }
  return pendingDeps(at) !== undefined;
}

/**
 * Validates an input that holds pending tokens. A token may stand for a number, an enum value or anything
 * else, so issues at a token are ignored and every other issue is still reported. Returns the parsed input
 * when it validates as is, else the raw input (which is only planned, never sent).
 */
function parsePending(def: FnDef, input: unknown): unknown {
  const r = def.input.safeParse(input);
  if (r.success) return r.data;
  const issues = (r.error.issues as Issue[]).filter((i) => !explainedByPending(input, i));
  if (issues.length > 0) throw invalidInput(def, issues);
  return input;
}

/** Validates a result. Upstream data never reaches the error: only the failing paths. */
function parseOutput(def: FnDef, value: unknown): unknown {
  const r = def.output.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, MAX_ISSUES).map((i) => ({ path: issuePath(i.path) }));
  throw new GwsError("GWS_RESPONSE_SHAPE", `the result of ${def.name} does not match its schema`, { details: { issues } });
}

/**
 * Step ids of the unexecuted writes a value depends on, or undefined when it holds no pending token. Any
 * string (or key) containing the token prefix counts, also embedded in a longer string, so a dependent value
 * is never sent upstream.
 */
function pendingDeps(value: unknown): StepId[] | undefined {
  let found = false;
  const deps = new Set<StepId>();
  const scan = (s: string) => {
    if (!s.includes(PENDING_TOKEN_PREFIX)) return;
    found = true;
    for (const m of s.matchAll(PENDING_STEP)) deps.add(m[1] as StepId);
  };
  // The input passed checkInputSize, so the walk is bounded by CALL_INPUT_MAX_BYTES. Binary data holds no
  // token and is never walked: Object.entries would allocate a pair per byte.
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") scan(v);
    else if (typeof v === "object" && v !== null && !seen.has(v) && !isBinary(v)) {
      seen.add(v);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push(v[i]);
      } else {
        for (const k of Object.keys(v)) {
          scan(k);
          stack.push((v as Record<string, unknown>)[k]);
        }
      }
    }
  }
  if (!found) return undefined;
  return [...deps].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** A planned request whose body is larger than PLAN_BODY_MAX_BYTES keeps only the body's size. */
function boundedRequest(request: PlanRequest): PlanRequest {
  if (request.body === undefined) return request;
  const bytes = approxJsonBytes(request.body);
  return bytes <= PLAN_BODY_MAX_BYTES ? request : { ...request, body: { bytes, truncated: true } };
}

function accountRef(input: unknown): string | undefined {
  const ref = typeof input === "object" && input !== null ? (input as { account?: unknown }).account : undefined;
  return typeof ref === "string" ? ref : undefined;
}

function toResolved(a: Account): ResolvedAccount {
  const r: ResolvedAccount = { id: a.id, email: a.email, scopes: [...a.scopes] };
  if (a.alias !== undefined) r.alias = a.alias;
  return r;
}

function checkScopes(def: FnDef, meta: MethodMeta, account: Account): void {
  if (meta.scopes.length === 0) return;
  const have = new Set(account.scopes);
  if (meta.scopes.some((s) => have.has(s))) return;
  throw new GwsError("GWS_SCOPE_MISSING", `the account has not granted any scope ${def.name} needs`, {
    details: { needAnyOf: [...meta.scopes], connectHint: `sdk.accounts.connect({services:['${meta.service}']})` },
  });
}

/**
 * One call session per execute: the single choke point every SDK call passes through, in order: call budget,
 * input size, rate limit, registry lookup, pending-token scan, zod input, then for Google fns account resolution, client
 * allowlist and scope check, then the write guard (plan, or run upstream once, queued for one of the
 * `UPSTREAM_CONCURRENCY` slots and under the execute's response-byte budget),
 * response cap and zod output.
 * Every call yields exactly one call record and one audit row, except repeated calls after the budget is
 * spent: only the first refused call is recorded, so a runaway loop cannot flood the audit batch.
 */
export function createCallSession(opts: CallSessionOptions): CallSession {
  const { ports, auth, apply, executeId } = opts;
  // The OAuth client takes its credentials by the session config's upstream; the transport must target the
  // same upstream, or a google-mode session could send the real client secret to the fake.
  if (ports.http.upstream !== opts.config.GOOGLE_UPSTREAM) {
    throw new GwsError("GWS_INTERNAL", "the session config and the env disagree on the Google upstream");
  }
  const config: Config = Object.freeze({ ...opts.config });
  const hostConfig = Object.freeze(Object.fromEntries(HOST_CONFIG_KEYS.map((k) => [k, config[k]]))) as HostConfig;
  const transport: Transport = ports.http.send;
  const registry = opts.registry ?? getRegistry();
  const now = opts.now ?? Date.now;
  const { accounts, approval, tokens } = ports;
  const frozenAuth: AuthProps = Object.freeze({ userId: auth.userId, clientId: auth.clientId });
  const budget = new CallBudget(config.CALLS_PER_EXECUTE);
  const upstream = new UpstreamLimits(config);
  const audit = new AuditBuffer();
  const plan: PlanStep[] = [];
  const calls: CallRecord[] = [];
  const inflight = new Set<Promise<DispatchResult>>();
  const running = new Set<CallEntry>();
  let seq = 0;
  let lastError: WireError | undefined;
  const errors: WireError[] = [];
  let appliedDestructive = false;
  let closed = false;
  let closing: Promise<void> | undefined;

  /** Records the error a call returned (see `errors`). */
  function noteError(wire: WireError): WireError {
    lastError = wire;
    if (!closed && (errors.length < MAX_KEPT_ERRORS || !errors.some((e) => e.code === wire.code))) errors.push(wire);
    return wire;
  }

  function pushStep(s: Omit<PlanStep, "step">): StepId {
    const id: StepId = `s${plan.length + 1}`;
    const step: PlanStep = { step: id, fn: String(s.fn), effect: s.effect === "write" ? "write" : "read", destructive: s.destructive === true };
    if (typeof s.account === "string") step.account = s.account;
    if (s.request !== undefined) step.request = boundedRequest(s.request);
    if (s.incomplete === true) step.incomplete = true;
    if (s.dependsOn !== undefined && s.dependsOn.length > 0) step.dependsOn = [...s.dependsOn];
    if (typeof s.note === "string") step.note = s.note;
    plan.push(step);
    return id;
  }

  /**
   * Resolves an account reference among the user's accounts and enforces the client allowlist. Every account
   * the client may not use (not allowlisted, unknown, another user's, a missing default, or not allowlisted
   * and in reconnect state) gives the same GWS_ACCOUNT_DENIED, so a client learns nothing about it.
   */
  async function allowedAccount(ref: string | undefined, trace?: Trace): Promise<Account> {
    let account: Account;
    try {
      account = await accounts.resolve(frozenAuth.userId, ref);
    } catch (e) {
      if (!isGwsError(e)) throw e;
      if (e.code === "GWS_ACCOUNT_UNKNOWN" || e.code === "GWS_NO_DEFAULT_ACCOUNT") throw accountDenied(ref);
      if (e.code === "GWS_RECONNECT_REQUIRED") {
        const target = (await accounts.listForUser(frozenAuth.userId)).find((a) => a.email === e.account);
        if (!target) throw accountDenied(ref);
        if (!(await approval.isAllowed(frozenAuth.userId, frozenAuth.clientId, target.id))) {
          if (trace) trace.accountId = target.id;
          throw accountDenied(ref);
        }
      }
      throw e;
    }
    if (trace) trace.accountId = account.id;
    if (!(await approval.isAllowed(frozenAuth.userId, frozenAuth.clientId, account.id))) throw accountDenied(ref);
    return account;
  }

  async function runGoogle(def: FnDef, input: unknown, deps: StepId[] | undefined, destructive: boolean, trace: Trace): Promise<Ran> {
    const meta = def.method;
    if (!meta) throw new GwsError("GWS_INTERNAL", "google fn without method metadata");
    const account = await allowedAccount(accountRef(input), trace);
    checkScopes(def, meta, account);
    trace.accountEmail = account.email;

    if (deps !== undefined) {
      const step: Omit<PlanStep, "step"> = { fn: def.name, account: account.email, effect: def.effect, destructive, incomplete: true, dependsOn: deps };
      if (def.effect === "write") step.request = describeRequest(buildRequest(meta, input));
      else step.note = INCOMPLETE_NOTE;
      return { kind: "pending", id: pushStep(step) };
    }
    if (def.effect === "write" && !apply) {
      const request = describeRequest(buildRequest(meta, input));
      return { kind: "pending", id: pushStep({ fn: def.name, account: account.email, effect: "write", destructive, request }) };
    }

    return upstream.run(async () => {
      const accessToken = await tokens.getAccessToken(account);
      const observed: Transport = async (url, init) => {
        // Applied means sent: a request refused while it is built never counts.
        trace.applied = def.effect === "write";
        if (trace.applied && destructive) appliedDestructive = true;
        const res = await transport(url, init);
        trace.upstreamStatus = res.status;
        return res;
      };
      try {
        const value = await callGoogle(meta, input, { accessToken, transport: observed, maxResponseBytes: config.CALL_RESPONSE_MAX_BYTES });
        upstream.spend(value);
        return { kind: "value", status: "ok", value } satisfies Ran;
      } catch (e) {
        // Google rejected the bearer token: drop it so the next call refreshes (or learns the grant is gone).
        // The call itself is never retried, and a cache error never replaces the upstream error.
        if (trace.upstreamStatus === 401) await tokens.invalidate(account.id).catch(() => undefined);
        throw e;
      }
    });
  }

  function hostCtx(def: FnDef, scope: HostScope): CallCtx {
    const { trace } = scope;
    const planStep = (step: Omit<PlanStep, "step">): StepId => {
      trace.planned = true;
      return pushStep(step);
    };
    const ctx: CallCtx = {
      apply,
      auth: frozenAuth,
      config: hostConfig,
      executeId,
      call: async (fnName: string, input: unknown): Promise<unknown> => {
        const r = await dispatchFrom(fnName, input, scope);
        if ("__gwsError" in r) throw fromWire(r.__gwsError);
        if ("__gwsPending" in r) return r;
        return r.value;
      },
      planStep,
      resolveAllowed: async (ref?: string): Promise<ResolvedAccount> => {
        if (ref !== undefined && typeof ref !== "string") {
          throw new GwsError("GWS_INVALID_INPUT", "account must be an email or alias", { details: { issues: [{ path: "account" }] } });
        }
        return toResolved(await allowedAccount(ref, trace));
      },
    };
    // Registry rule: only accounts.* fns have service "accounts".
    if (def.service === "accounts") {
      ctx.accounts = createAccountsCapability({
        store: { accounts, grants: approval },
        auth: frozenAuth,
        apply,
        config,
        kv: ports.links,
        oauth: createGoogleOAuth(config, ports.secrets, transport),
        upstream: (fn) => upstream.run(fn),
        invalidateToken: (accountId) => tokens.invalidate(accountId),
        now,
        plan: planStep,
        applied: (accountId, destructive) => {
          trace.applied = true;
          if (accountId !== null) trace.accountId = accountId;
          if (destructive) appliedDestructive = true;
        },
      });
    }
    return Object.freeze(ctx);
  }

  async function runHost(def: FnDef, input: unknown, deps: StepId[] | undefined, destructive: boolean, trace: Trace): Promise<Ran> {
    if (!def.run) throw new GwsError("GWS_INTERNAL", "host fn without run");
    if (deps !== undefined) {
      return { kind: "pending", id: pushStep({ fn: def.name, effect: def.effect, destructive, incomplete: true, dependsOn: deps, note: INCOMPLETE_NOTE }) };
    }
    const scope: HostScope = { active: true, trace };
    let value: unknown;
    try {
      value = await def.run(input, hostCtx(def, scope));
    } finally {
      scope.active = false;
    }
    // `trace.applied` is observed, never inferred: set by a capability write or by an applied nested call.
    return { kind: "value", status: trace.planned ? "planned" : "ok", value };
  }

  async function run(def: FnDef | undefined, input: unknown, trace: Trace): Promise<Ran> {
    // First, before anything walks the input or waits holding it.
    checkInputSize(input, config.CALL_INPUT_MAX_BYTES);
    await checkRate(ports.rate, frozenAuth, now(), config);
    if (!def) throw new GwsError("GWS_UNKNOWN_METHOD", "no SDK function has this name; use search to find one");
    // Scan the raw input before validation: a token may stand where a number or an enum value is expected.
    const deps = pendingDeps(input);
    const parsed = deps === undefined ? parseInput(def, input) : parsePending(def, input);
    const { destructive } = isDestructive(def.name, parsed);
    const ran =
      def.kind === "google" ? await runGoogle(def, parsed, deps, destructive, trace) : await runHost(def, parsed, deps, destructive, trace);
    if (ran.kind === "pending") return ran;
    capBytes(ran.value, config.CALL_RESPONSE_MAX_BYTES);
    return { ...ran, value: parseOutput(def, ran.value) };
  }

  /** Writes the call record and audit row of a call, once. */
  function record(entry: CallEntry, status: CallStatus, code: GwsErrorCode | null, requestId: string | null): void {
    if (entry.recorded) return;
    entry.recorded = true;
    running.delete(entry);
    const { trace } = entry;
    const ms = Math.max(0, Math.round(now() - entry.started));
    const rec: CallRecord = { seq: entry.seq, fn: entry.label, effect: entry.effect, status, ms };
    if (trace.accountEmail !== undefined) rec.account = trace.accountEmail;
    if (code !== null) rec.code = code;
    calls.push(rec);
    audit.add({
      id: crypto.randomUUID(),
      ts: entry.started,
      execute_id: executeId,
      user_id: frozenAuth.userId,
      client_id: frozenAuth.clientId,
      account_id: trace.accountId,
      fn: entry.label,
      effect: entry.effect,
      applied: trace.applied ? 1 : 0,
      status,
      code,
      duration_ms: ms,
      request_id: requestId,
      upstream_status: trace.upstreamStatus,
    });
  }

  async function dispatchUnsafe(fnName: unknown, input: unknown, parent: HostScope | undefined): Promise<DispatchResult> {
    const started = now();
    const def = typeof fnName === "string" ? registry.get(fnName) : undefined;
    const trace: Trace = { accountId: null, applied: false, upstreamStatus: null, planned: false };

    let overBudget: unknown;
    try {
      budget.take();
    } catch (e) {
      overBudget = e;
    }
    if (overBudget !== undefined && budget.refused > 1) {
      return { __gwsError: noteError(safeWire(overBudget)) };
    }
    const entry: CallEntry = { seq: ++seq, label: def?.name ?? UNKNOWN_FN, effect: def?.effect ?? "read", started, trace, recorded: false };
    running.add(entry);

    let result: DispatchResult;
    let status: CallStatus;
    let code: GwsErrorCode | null = null;
    let requestId: string | null = null;
    try {
      if (overBudget !== undefined) throw overBudget;
      const ran = await run(def, input, trace);
      if (ran.kind === "pending") {
        status = "planned";
        result = { __gwsPending: ran.id };
      } else {
        status = ran.status;
        result = { ok: true, value: ran.value };
      }
    } catch (e) {
      const wire = safeWire(e);
      if (wire.fn === undefined) wire.fn = entry.label;
      code = wire.code;
      status = DENIED_CODES.has(wire.code) ? "denied" : "error";
      const rid = wire.details?.requestId;
      if (typeof rid === "string") requestId = rid;
      result = { __gwsError: noteError(wire) };
    }
    // A host fn whose nested call changed state upstream changed state too.
    if (parent && trace.applied) parent.trace.applied = true;
    record(entry, status, code, requestId);
    return result;
  }

  async function dispatchSafe(fnName: unknown, input: unknown, parent: HostScope | undefined): Promise<DispatchResult> {
    try {
      return await dispatchUnsafe(fnName, input, parent);
    } catch {
      // Last resort: nothing crosses the RPC boundary as an exception.
      return { __gwsError: noteError({ code: "GWS_INTERNAL", message: "internal error" }) };
    }
  }

  function dispatchFrom(fnName: unknown, input: unknown, parent: HostScope | undefined): Promise<DispatchResult> {
    if (closed && !parent?.active) {
      return Promise.resolve({ __gwsError: { code: "GWS_EXECUTION_ERROR", message: "this execute has finished; no more SDK calls are accepted" } });
    }
    const p = dispatchSafe(fnName, input, parent);
    inflight.add(p);
    void p.then(() => inflight.delete(p));
    return p;
  }

  async function closeOnce(waitMs: number): Promise<void> {
    closed = true;
    // A queued call has sent nothing yet: release it now rather than send it after the execute ended.
    upstream.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), waitMs);
    });
    try {
      // Nested calls of a running host fn may still start while waiting, so wait until nothing is in flight.
      while (inflight.size > 0) {
        if ((await Promise.race([Promise.allSettled([...inflight]), expired])) === "expired") break;
      }
    } finally {
      clearTimeout(timer);
    }
    // Calls still running are recorded now, with what they did so far (an applied write stays applied).
    for (const entry of [...running]) record(entry, "error", "GWS_EXECUTION_TIMEOUT", null);
    await audit.flush(ports.audit);
  }

  return {
    dispatch: (fnName: unknown, input: unknown) => dispatchFrom(fnName, input, undefined),
    get plan() {
      return plan;
    },
    get calls() {
      return calls;
    },
    get destructive() {
      return plan.some((s) => s.destructive);
    },
    get appliedDestructive() {
      return appliedDestructive;
    },
    get unauditedRefusals() {
      return Math.max(0, budget.refused - 1);
    },
    get lastError() {
      return lastError;
    },
    get errors() {
      return errors;
    },
    flush: () => audit.flush(ports.audit),
    close(o: CloseOptions = {}) {
      closing ??= closeOnce(o.waitMs ?? config.EXECUTE_TIMEOUT_MS).catch((e: unknown) => {
        // A failed flush keeps its rows buffered: let a later close retry it.
        closing = undefined;
        throw e;
      });
      return closing;
    },
  };
}

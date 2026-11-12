import { FAKE_CLIENT_SECRET, type Config } from "../config";
import { SECRET_NAMES, type ApprovalOffer, type AuditRow, type AuthProps, type ExecuteOutput, type PlanStep, type UserLink } from "../contracts";
import { GWS_ERROR_CODES, GwsError, isGwsError, toWire, type GwsErrorCode, type WireError } from "../errors";
import { createCallSession, type CallSession, type SessionApproval, type SessionPortsWithAccess } from "./dispatch";
import {
  approvalMintedRow,
  approvalOffer,
  approvalPlanHash,
  approvalRequired,
  approvalUsedRow,
  approvedSteps,
  mintApprovalLink,
  type GatedStep,
  type HumanApprovalPort,
  type NoLinkReason,
} from "./human-approval";
import { capBytes, checkRate, jsonBytes } from "./limits";
import type { CorePorts, SandboxCall, SandboxPort, SandboxResult, SecretSource } from "./ports";
import { SDK_PRELUDE } from "./prelude";
import { redact, redactDeep } from "./redact";
import type { Registry } from "./registry";

export type { SandboxCall };

/**
 * How a sandbox run ended: the snippet's result as JSON text, the message it ended with, or the limit that
 * ended it (wall-clock `timeoutMs`, or the child's CPU limit).
 */
export type SandboxRun =
  | { status: "returned"; json: string | undefined; logs: string[] }
  | { status: "threw"; message: string; logs: string[]; refusals?: WireError[] }
  | { status: "timed-out"; limit: "wall" | "cpu"; logs: string[] };

export interface SandboxOptions {
  sandbox: SandboxPort;
  timeoutMs: number;
  /** CPU limit of the sandbox, per run. */
  cpuMs: number;
  /** Memory limit of the sandbox; EXECUTE_MEMORY_BYTES when omitted. */
  memoryBytes?: number;
  code: string;
  call: SandboxCall;
}

/**
 * CPU time one execute's sandbox may use. Snippets are I/O-bound, so this is far above any real snippet, and
 * it ends a synchronous busy loop long before the platform default (30 s) would.
 */
export const EXECUTE_CPU_MS = 5000;
/**
 * Memory one execute's sandbox may use: the Workers isolate limit (128 MB), which the platform enforces and a
 * Worker Loader child cannot lower. A runtime that cannot enforce a requested limit refuses the run.
 */
export const EXECUTE_MEMORY_BYTES = 128 * 1024 * 1024;
/**
 * The host stops waiting for the sandbox this long after `timeoutMs`. The in-sandbox timer looks up
 * `setTimeout` on the snippet-writable global, so the snippet can disable it; this deadline it cannot.
 */
export const HOST_DEADLINE_GRACE_MS = 250;
/** Longest snippet error message returned, in UTF-16 units. */
const MAX_ERROR_TEXT = 1000;
/** Sandbox refusals considered when the snippet ends with an error. */
const MAX_REFUSALS = 16;
const ERROR_CODES: ReadonlySet<string> = new Set(GWS_ERROR_CODES);
const INTERNAL_REPLY = { __gwsError: { code: "GWS_INTERNAL", message: "internal error" } } as const;

/**
 * Runs the snippet after the sdk prelude, then JSON-serializes its result inside the sandbox: pending
 * proxies become their tokens, and nothing but JSON text (no functions, proxies or RPC stubs) comes back.
 * Anything thrown is normalized to an Error with a non-empty message, because a sandbox may report an error
 * only when its message is truthy (the Workers executor does).
 */
function wrapSnippet(normalized: string): string {
  return [
    "async () => {",
    "  let __gwsResult;",
    "  try {",
    "    __gwsResult = await (",
    normalized,
    "    )();",
    "  } catch (e) {",
    '    throw new Error(e instanceof Error ? e.message || e.name || "Error" : "the snippet threw a " + typeof e);',
    "  }",
    "  return __gwsResult === undefined ? undefined : JSON.stringify(__gwsResult);",
    "}",
  ].join("\n");
}

/**
 * The adapter's refusals, type-checked: a known code, a message within MAX_ERROR_TEXT and flat details only. Anything
 * else is dropped (the snippet then reports its own text as GWS_EXECUTION_ERROR, as before).
 */
function checkedRefusals(value: unknown): WireError[] {
  if (!Array.isArray(value)) return [];
  const out: WireError[] = [];
  for (const r of value.slice(0, MAX_REFUSALS)) {
    if (typeof r !== "object" || r === null) continue;
    const { code, message, details } = r as Record<string, unknown>;
    if (typeof code !== "string" || !ERROR_CODES.has(code) || typeof message !== "string" || message.length > MAX_ERROR_TEXT) continue;
    const wire: WireError = { code: code as GwsErrorCode, message };
    if (typeof details === "object" && details !== null && !Array.isArray(details)) {
      const flat = Object.entries(details).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
      if (flat.length > 0) wire.details = Object.fromEntries(flat.slice(0, 8));
    }
    out.push(wire);
  }
  return out;
}

/**
 * Runs a snippet in a fresh sandbox from the runtime's SandboxPort, with time, CPU and memory limits: the only
 * things passed in are the `__gws` call and the sdk prelude (no network, env, binding or module).
 *
 * `call` never throws into the sandbox: an exception becomes a GWS_INTERNAL error envelope, so no host
 * error message crosses the boundary. The host stops waiting at `timeoutMs + HOST_DEADLINE_GRACE_MS` whatever
 * the snippet or the sandbox does; the caller must then close the call session so later calls are refused.
 */
export async function runSandbox(opts: SandboxOptions): Promise<SandboxRun> {
  const call: SandboxCall = async (name, input) => {
    try {
      return await opts.call(name, input);
    } catch {
      return INTERNAL_REPLY;
    }
  };
  const code = wrapSnippet(opts.sandbox.normalize(opts.code));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), opts.timeoutMs + HOST_DEADLINE_GRACE_MS);
  });
  // Started inside a promise, so an adapter that throws synchronously still lands in the catch below.
  const running = Promise.resolve().then(() =>
    opts.sandbox.run({
      code,
      prelude: SDK_PRELUDE,
      call,
      limits: { timeoutMs: opts.timeoutMs, cpuMs: opts.cpuMs, memoryBytes: opts.memoryBytes ?? EXECUTE_MEMORY_BYTES },
    }),
  );
  // Settles after the deadline when the snippet outlives it; nothing waits for it then.
  running.catch(() => undefined);
  let out: SandboxResult;
  try {
    const first = await Promise.race([running, deadline]);
    if (first === "deadline") return { status: "timed-out", limit: "wall", logs: [] };
    out = first;
  } catch (e) {
    // The runtime refused the run (a limit it cannot enforce, say): a host failure, never a snippet outcome.
    if (e instanceof GwsError) throw e;
    // The sandbox itself failed (a syntax error in the snippet ends up here).
    const message = e instanceof Error && e.message ? e.message : "the sandbox failed";
    return { status: "threw", message, logs: [] };
  } finally {
    clearTimeout(timer);
  }
  const logs = Array.isArray(out.logs) ? out.logs.map((l) => (typeof l === "string" ? l : "[unprintable log entry]")) : [];
  if (out.limit === "wall" || out.limit === "cpu") return { status: "timed-out", limit: out.limit, logs };
  if (out.error !== undefined) {
    const threw: SandboxRun = { status: "threw", message: typeof out.error === "string" ? out.error : "the snippet failed", logs };
    const refusals = checkedRefusals(out.refusals);
    if (refusals.length > 0) threw.refusals = refusals;
    return threw;
  }
  // The snippet can replace JSON.stringify inside its own sandbox; accept only what the wrapper produces.
  if (out.result !== undefined && typeof out.result !== "string") {
    return { status: "threw", message: "the snippet result is not JSON-serializable", logs };
  }
  return { status: "returned", json: out.result, logs };
}

export interface ExecuteRequest {
  code: string;
  apply: boolean;
  auth: AuthProps;
  /**
   * The runtime's ports (sandbox, stores, secrets, HTTP), plus the web runtime's own (access list, setting link page,
   * approval page) when it has them.
   */
  ports: CorePorts & Pick<SessionPortsWithAccess, "access" | "settingLinks" | "humanApprovals">;
  config: Config;
  /** Functions callable in this execute; the SDK registry when omitted. */
  registry?: Registry;
  /** Clock for timestamps and rate windows; `Date.now` when omitted. */
  now?: () => number;
}

/** An approval link, or why none was handed out (`audit-lost`: it was made but its audit row could not be written). */
type UserLinkOr = UserLink | NoLinkReason | "audit-lost";

/** `ExecuteOutput` plus the count of over-budget calls that were refused without an audit row. */
export interface ExecuteReport extends ExecuteOutput {
  unauditedRefusals: number;
}

/**
 * Secret values that must never appear in an execute's output, whatever the shape: every secret in
 * SECRET_NAMES (so a new secret is covered without a change here) and the fake client's secret.
 */
function knownSecrets(secrets: SecretSource): string[] {
  return [...SECRET_NAMES.map((name): unknown => secrets.get(name)), FAKE_CLIENT_SECRET].filter((s): s is string => typeof s === "string");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Maps how the snippet ended to a structured error. A snippet ended by an SDK error carries the message
 * `<code>: <message>` of that error; the recorded error it came from is returned then, already scrubbed: the one
 * with exactly that text, else the first with that code. `recorded` holds what the snippet could have seen: the
 * errors calls returned before the session closed and the sandbox's own refusals, never an error the end of the
 * execute caused. Any other message is the snippet's own, reported as GWS_EXECUTION_ERROR.
 */
function snippetError(message: string, recorded: readonly WireError[], secrets: readonly string[]): WireError {
  const sdkError =
    recorded.find((e) => message === `${e.code}: ${e.message}`) ?? recorded.find((e) => message.startsWith(`${e.code}: `));
  if (sdkError !== undefined) return redactDeep(sdkError, secrets) as WireError;
  return { code: "GWS_EXECUTION_ERROR", message: redact(clip(message, MAX_ERROR_TEXT), secrets) };
}

function timeoutError(limit: "wall" | "cpu", timeoutMs: number): WireError {
  if (limit === "cpu") {
    return {
      code: "GWS_EXECUTION_TIMEOUT",
      message: `the snippet used more than ${EXECUTE_CPU_MS} ms of CPU time`,
      details: { cpuMs: EXECUTE_CPU_MS },
    };
  }
  return { code: "GWS_EXECUTION_TIMEOUT", message: `the snippet did not finish within ${timeoutMs} ms`, details: { timeoutMs } };
}

/** The leading log lines whose total stays within `max` bytes. */
function fitLines(lines: readonly string[], max: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    // UTF-8 is never shorter than the UTF-16 length: a longer line is over the cap unmeasured.
    bytes += line.length > max ? line.length : jsonBytes(line);
    if (bytes > max) break;
    kept.push(line);
  }
  return kept;
}

/**
 * Keeps log lines, in order, while their total stays within `max` bytes, and notes how many were dropped.
 * The raw lines are capped first and only those kept are redacted, so redaction work is bounded by `max`;
 * the redacted lines are capped again, since a redaction can be longer than a short token.
 */
function boundLogs(lines: readonly string[], max: number, secrets: readonly string[]): string[] {
  const kept = fitLines(
    fitLines(lines, max).map((l) => redact(l, secrets)),
    max,
  );
  if (kept.length < lines.length) kept.push(`[logs truncated: ${lines.length - kept.length} more lines]`);
  return kept;
}

const REQUEST_OMITTED = "request omitted: the plan is larger than RESULT_MAX_BYTES";

/** Keeps the plan within `max` bytes: once it is over, later steps keep everything but their request. */
function boundPlan(plan: readonly PlanStep[], max: number): PlanStep[] {
  let bytes = 0;
  return plan.map((step) => {
    const size = jsonBytes(step);
    if (step.request === undefined || bytes + size <= max) {
      bytes += size;
      return step;
    }
    const { request: _omitted, ...rest } = step;
    const slim: PlanStep = { ...rest, note: rest.note === undefined ? REQUEST_OMITTED : `${rest.note}; ${REQUEST_OMITTED}` };
    bytes += jsonBytes(slim);
    return slim;
  });
}

/**
 * Parses the snippet's JSON result, redacts it and caps it at `max` bytes. Text longer than twice the cap is
 * refused before parsing (a UTF-16 unit is at least one UTF-8 byte; the slack lets redaction shrink a result).
 */
function parseResult(json: string, max: number, secrets: readonly string[]): unknown {
  if (json.length > 2 * max) {
    throw new GwsError("GWS_RESPONSE_TOO_LARGE", `the result is larger than ${max} bytes`, { details: { scope: "result", max } });
  }
  const value = redactDeep(JSON.parse(json) as unknown, secrets);
  capBytes(value, max, "result");
  return value;
}

function failure(e: unknown): WireError {
  try {
    return toWire(e);
  } catch {
    return { code: "GWS_INTERNAL", message: "internal error" };
  }
}

const AUDIT_LOST: WireError = { code: "GWS_INTERNAL", message: "the audit log of this execute could not be written" };

/** The audit-row prefix of a planning pass's calls: they belong to the apply execute but are not its own calls. */
export const PLANNING_PASS_PREFIX = "plan:";

/** What an `apply: true` run with steps that need approval may do: run with these approved steps, or stop here. */
type ApplyGate = { approved: Map<string, number>; used?: AuditRow } | { refusal: ExecuteReport };

/**
 * Runs one `execute`: a rate-limit count for the execute itself, a fresh call session (one executeId), the
 * snippet in the sandbox, then the output with logs, result and error redacted and capped at
 * `RESULT_MAX_BYTES`. The session is closed as soon as the sandbox run ends (in a `finally`, so on every
 * path), before any snippet output is processed: calls the snippet left running, such as an un-awaited
 * applied write, finish and get their audit rows even if processing that output fails.
 *
 * With GWS_HUMAN_APPROVAL on (see human-approval.ts): a dry run whose plan has steps that need approval returns an
 * approval link in `approval`; an `apply: true` run first repeats the dry run (the planning pass, audited under
 * `plan:<executeId>`) and runs only with an unused approval of exactly that plan, which it uses up; otherwise it stops
 * with GWS_APPROVAL_REQUIRED before any write.
 */
export async function runExecute(req: ExecuteRequest): Promise<ExecuteReport> {
  const { code, apply, auth, ports, config } = req;
  const now = req.now ?? Date.now;
  const executeId = crypto.randomUUID();
  const humanApproval: SessionApproval | undefined = config.GWS_HUMAN_APPROVAL.length > 0 ? { reasons: new Set(config.GWS_HUMAN_APPROVAL) } : undefined;
  const report = (
    session: CallSession | undefined,
    fields: { result?: unknown; error?: WireError; logs: string[]; approval?: ApprovalOffer | undefined },
  ): ExecuteReport => {
    const out: ExecuteReport = {
      ok: fields.error === undefined,
      executeId,
      applied: apply,
      destructive: session !== undefined && (session.destructive || session.appliedDestructive),
      logs: fields.logs,
      calls: session ? [...session.calls] : [],
      plan: session ? boundPlan(session.plan, config.RESULT_MAX_BYTES) : [],
      unauditedRefusals: session?.unauditedRefusals ?? 0,
    };
    if (fields.result !== undefined) out.result = fields.result;
    if (fields.error !== undefined) out.error = fields.error;
    if (fields.approval !== undefined) out.approval = fields.approval;
    return out;
  };
  const newSession = (id: string, applyMode: boolean) =>
    createCallSession({
      ports,
      auth,
      apply: applyMode,
      executeId: id,
      config,
      now,
      ...(req.registry ? { registry: req.registry } : {}),
      ...(humanApproval ? { humanApproval } : {}),
    });
  const sandboxRun = (target: CallSession) =>
    runSandbox({ sandbox: ports.sandbox, timeoutMs: config.EXECUTE_TIMEOUT_MS, cpuMs: EXECUTE_CPU_MS, code, call: (n, i) => target.dispatch(n, i) });

  /**
   * A one-time approval link for these steps, with its audit row flushed through `audit`; or why there is none. A link
   * that cannot be made, or whose audit row cannot be written, is not handed out.
   */
  async function offerLink(audit: CallSession, steps: readonly GatedStep[], approvals: HumanApprovalPort | undefined): Promise<UserLinkOr> {
    if (approvals === undefined) return "no-page";
    if (steps.some((s) => s.incomplete)) return "dependent";
    let minted: Awaited<ReturnType<typeof mintApprovalLink>>;
    try {
      const planHash = await approvalPlanHash({ userId: auth.userId, clientId: auth.clientId, code, digests: steps.map((s) => s.digest) });
      // The plan's other writes go along as context for the person; they need no approval.
      const context = audit.plan.filter((s) => s.effect === "write" && s.needsApproval !== true);
      minted = await mintApprovalLink({ links: ports.links, baseUrl: config.PUBLIC_BASE_URL, auth, executeId, now: now() }, { planHash, steps, context });
    } catch {
      return "link-failed";
    }
    audit.addAudit(approvalMintedRow(minted.record, now()));
    try {
      await audit.flush();
    } catch {
      return "audit-lost";
    }
    return minted.link;
  }

  /**
   * Before an `apply: true` run: the planning pass (the same code as a dry run, so no write) finds the steps that need
   * approval and their plan hash; then one unused approval of that hash, user and client is used up. Nothing is
   * written by this; without such an approval the execute stops with GWS_APPROVAL_REQUIRED and a fresh link.
   */
  async function gateApply(approvals: HumanApprovalPort | undefined): Promise<ApplyGate> {
    if (approvals === undefined) return { approved: new Map() };
    const planning = newSession(`${PLANNING_PASS_PREFIX}${executeId}`, false);
    let stopped: WireError | undefined;
    try {
      await sandboxRun(planning);
    } catch (e) {
      // The runtime refused the run: the applied run would be refused the same way.
      stopped = failure(e);
    } finally {
      try {
        await planning.close();
      } catch {
        stopped = AUDIT_LOST;
      }
    }
    if (stopped !== undefined) return { refusal: report(planning, { error: stopped, logs: [] }) };
    const steps = planning.gatedSteps;
    if (steps.length === 0) return { approved: new Map() };
    if (!steps.some((s) => s.incomplete)) {
      const planHash = await approvalPlanHash({ userId: auth.userId, clientId: auth.clientId, code, digests: steps.map((s) => s.digest) });
      const approvalId = await approvals.claim({ planHash, userId: auth.userId, clientId: auth.clientId, now: now() });
      if (approvalId !== null) return { approved: approvedSteps(steps), used: approvalUsedRow(executeId, auth, approvalId, now()) };
    }
    const made = await offerLink(planning, steps, approvals);
    if (made === "audit-lost") return { refusal: report(planning, { error: AUDIT_LOST, logs: [] }) };
    return { refusal: report(planning, { error: failure(approvalRequired(steps, made)), logs: [], approval: approvalOffer(steps, made) }) };
  }

  let session: CallSession;
  try {
    session = newSession(executeId, apply);
  } catch (e) {
    return report(undefined, { error: failure(e), logs: [] });
  }

  let run: SandboxRun | undefined;
  let error: WireError | undefined;
  let refusal: ExecuteReport | undefined;
  let audited = true;
  try {
    // Each execute counts once, so a snippet that makes no SDK call is rate-limited too.
    await checkRate(ports.rate, auth, now(), config);
    if (apply && humanApproval !== undefined) {
      const gate = await gateApply(ports.humanApprovals);
      if ("refusal" in gate) refusal = gate.refusal;
      else {
        humanApproval.approved = gate.approved;
        if (gate.used !== undefined) session.addAudit(gate.used);
      }
    }
    if (refusal === undefined) run = await sandboxRun(session);
  } catch (e) {
    error = failure(e);
  } finally {
    try {
      await session.close();
    } catch {
      audited = false;
    }
  }
  if (refusal !== undefined) return audited ? refusal : { ...refusal, error: AUDIT_LOST, ok: false };

  // A dry run whose plan has steps that need approval offers the person's approval link.
  let approval: ApprovalOffer | undefined;
  const gated = !apply && audited ? session.gatedSteps : [];
  if (gated.length > 0) {
    const made = await offerLink(session, gated, ports.humanApprovals);
    if (made === "audit-lost") audited = false;
    else approval = approvalOffer(gated, made);
  }

  // The session is closed: every value it handled is known by now.
  const secrets = [...knownSecrets(ports.secrets), ...session.sensitive];
  let result: unknown;
  let logs: string[] = [];
  if (run !== undefined) {
    try {
      logs = boundLogs(run.logs, config.RESULT_MAX_BYTES, secrets);
      if (run.status === "timed-out") error = timeoutError(run.limit, config.EXECUTE_TIMEOUT_MS);
      else if (run.status === "threw") error = snippetError(run.message, [...session.errors, ...(run.refusals ?? [])], secrets);
      else if (run.json !== undefined) result = parseResult(run.json, config.RESULT_MAX_BYTES, secrets);
    } catch (e) {
      error = isGwsError(e) ? failure(e) : { code: "GWS_EXECUTION_ERROR", message: "the snippet result could not be processed" };
    }
  }
  // The calls ran but their audit rows were not written: that outranks any snippet outcome.
  if (!audited) error = AUDIT_LOST;
  return report(session, { result, error, logs, approval });
}

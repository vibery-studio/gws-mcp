import { z } from "zod";
import { HUMAN_APPROVAL_REASONS, type HumanApprovalReason } from "../config";
import type { ApprovalOffer, AuditRow, AuthProps, PlanRequest, PlanStep, StepId, UserLink } from "../contracts";
import { GwsError } from "../errors";
import { DESTRUCTIVE_REASON_WORDS } from "./destructive";
import { LINK_TTL_MS, isLinkToken, linkKey, newLinkToken } from "./links";
import type { LinkStore } from "./ports";

/**
 * Human approval of high-impact plan steps (GWS_HUMAN_APPROVAL). A step whose destructive reason is on the list never
 * runs on the AI app's own `apply: true`: the person approves the exact plan on a gws-mcp page first.
 *
 * - A dry run with such steps returns a one-time approval link (the same link mechanism as setting links: a hash of a
 *   32-byte token, 10 minutes, single use, the page needs the same person's web session). The link is bound to the
 *   user, the client and the plan hash: the code's hash plus, for each such step, its fn, account, reason and the
 *   request it would send (method, URL, query and a digest of the exact body bytes).
 * - The page shows every such step in full, or offers no Approve at all: a step too large to show cannot be approved.
 * - Approving records an approval row for that plan hash, user and client, in one transaction with the link's use.
 * - An `apply: true` run first repeats the dry run (the planning pass) to compute the same hash before any write, then
 *   marks one unused approval of that hash, user and client used, in one conditional UPDATE. Without one it answers
 *   GWS_APPROVAL_REQUIRED with a fresh link, and nothing is written. The applied run may then send exactly the approved
 *   steps, each once: any other step with a listed reason is refused, so code that behaves differently under apply
 *   still cannot run an unapproved step.
 */

/** The `used_links` purpose and link kind of an approval link. */
export const APPROVAL_LINK_PURPOSE = "approval";
/** The page an approval link opens. */
export const APPROVAL_LINK_PATH = "/plan/approve";
/** How long an approval can be used after the person gave it. */
export const APPROVAL_TTL_MS = LINK_TTL_MS;
/**
 * The multipart boundary the digest is computed with: the sent request uses a random one, so the digest covers every
 * byte sent except the boundary. JSON bodies are digested exactly as sent.
 */
export const APPROVAL_DIGEST_BOUNDARY = "gws-mcp-approval-digest";
/** Longest request body the page shows, as displayed (escapes included). A longer one is never approvable. */
export const VIEW_BODY_MAX = 16_000;
/** Longest request URL the page shows, as displayed. A longer one is never approvable. */
const VIEW_TARGET_MAX = 4096;
/** Longest body of a context step (a write that needs no approval), as displayed; it is marked when cut. */
const CONTEXT_BODY_MAX = 2000;
/** Most context steps an approval page lists; the rest are counted. */
const CONTEXT_MAX = 50;

const Reason = z.enum(HUMAN_APPROVAL_REASONS);

/** One step that needs approval, as the page shows it. */
const ApprovalStepView = z.strictObject({
  fn: z.string().min(1).max(300),
  account: z.string().min(1).max(320),
  reason: Reason,
  method: z.string().min(1).max(16),
  /** The request URL with its query, in full; empty when it is too large to show. */
  target: z.string().max(VIEW_TARGET_MAX),
  /** The request body as indented JSON, in full. */
  body: z.string().max(VIEW_BODY_MAX).optional(),
  /** The URL or the body is too large to show in full: the plan cannot be approved on the page. */
  tooLarge: z.literal(true).optional(),
});
export type ApprovalStepView = z.output<typeof ApprovalStepView>;

/** Another write of the plan, needing no approval, shown on the page as context. */
const ContextStepView = z.strictObject({
  fn: z.string().min(1).max(300),
  account: z.string().max(320).optional(),
  method: z.string().max(16).optional(),
  target: z.string().max(VIEW_TARGET_MAX).optional(),
  body: z.string().max(CONTEXT_BODY_MAX).optional(),
  shortened: z.literal(true).optional(),
  note: z.string().max(500).optional(),
});
export type ContextStepView = z.output<typeof ContextStepView>;

/** A step with a listed reason, as a call session records it. */
export interface GatedStep {
  step: StepId;
  reason: HumanApprovalReason;
  /** The step's digest: what the plan hash and the applied run's matching use. Empty for an incomplete step. */
  digest: string;
  view: ApprovalStepView;
  /** The step uses the result of an unexecuted write: its request is not known yet, so it cannot be approved. */
  incomplete: boolean;
}

/** JSON with object keys sorted at every level, so equal values give equal text whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- What the person sees -------------------------------------------------------------------------------

/**
 * Characters that are invisible or change how text around them is shown: controls, format characters (bidi
 * overrides and isolates, zero-width characters, soft hyphen, tag characters), line and paragraph separators,
 * private-use and unassigned code points, and every space other than the plain one.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}   -   　]/gu;
/** A letter outside ASCII: it can look like an ASCII letter (a Cyrillic "о" in a domain, say). */
const NON_ASCII_LETTER = /(?![\p{ASCII}])\p{L}/u;

/** `text` with every hidden character written out as a visible escape, like ⟦U+202E⟧. */
export function visibleText(text: string): string {
  return text.replace(HIDDEN, (c) => `⟦U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟧`);
}

/** Whether `text` holds letters outside ASCII, which the page marks with a warning. */
export function hasNonAsciiLetters(text: string): boolean {
  return NON_ASCII_LETTER.test(text);
}

/** A value as indented JSON lines, each line made visible: what the page shows of a body. */
export function bodyLines(text: string): string[] {
  return text.split("\n").map(visibleText);
}

/** Displayed length of indented JSON: the lines as shown, joined. */
function shownLength(text: string): number {
  return bodyLines(text).join("\n").length;
}

function targetOf(request: PlanRequest): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(request.query)) for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
  const text = qs.toString();
  return text === "" ? request.url : `${request.url}?${text}`;
}

// ---- Digests --------------------------------------------------------------------------------------------

/**
 * The digest of one step with a listed reason: the fn, the account, the reason, the request as described in the plan
 * (method, URL, query) and the exact body bytes sent (`sentBody`: the built request's body; a multipart body built with
 * APPROVAL_DIGEST_BOUNDARY).
 */
export async function stepDigest(s: { fn: string; account: string; reason: HumanApprovalReason; request: PlanRequest; sentBody: string | Uint8Array | undefined }): Promise<string> {
  const { request } = s;
  const bodyDigest = s.sentBody === undefined ? null : await sha256Hex(s.sentBody);
  return sha256Hex(canonicalJson({ fn: s.fn, account: s.account, reason: s.reason, method: request.method, url: request.url, query: request.query, body: bodyDigest }));
}

/** The digest (see `stepDigest`) and page view of one step with a listed reason. */
export async function gatedStep(s: {
  step: StepId;
  fn: string;
  account: string;
  reason: HumanApprovalReason;
  request: PlanRequest;
  sentBody: string | Uint8Array | undefined;
  incomplete: boolean;
}): Promise<GatedStep> {
  const { request } = s;
  const digest = s.incomplete ? "" : await stepDigest(s);
  const target = targetOf(request);
  const view: ApprovalStepView = { fn: s.fn, account: s.account, reason: s.reason, method: request.method, target: "" };
  let tooLarge = visibleText(target).length > VIEW_TARGET_MAX;
  if (!tooLarge) view.target = target;
  if (request.body !== undefined) {
    const text = JSON.stringify(request.body, null, 2) ?? "";
    if (shownLength(text) > VIEW_BODY_MAX) tooLarge = true;
    else view.body = text;
  }
  if (tooLarge) view.tooLarge = true;
  return { step: s.step, reason: s.reason, digest, view, incomplete: s.incomplete };
}

/**
 * A host fn's step with a listed reason that waits on an unexecuted write (a helper such as `calendar.share` given a
 * pending id): its requests are not known yet, so it can never be approved as planned.
 */
export function incompleteHostStep(step: StepId, fn: string, reason: HumanApprovalReason): GatedStep {
  return { step, reason, digest: "", view: { fn, account: "-", reason, method: "-", target: "" }, incomplete: true };
}

/** The page's view of a plan write that needs no approval. */
export function contextStep(step: PlanStep): ContextStepView {
  const view: ContextStepView = { fn: step.fn };
  if (step.account !== undefined) view.account = step.account;
  if (step.request !== undefined) {
    view.method = step.request.method;
    const target = targetOf(step.request);
    view.target = target.slice(0, VIEW_TARGET_MAX);
    if (step.request.body !== undefined) {
      const text = JSON.stringify(step.request.body, null, 2) ?? "";
      view.body = text.slice(0, CONTEXT_BODY_MAX);
      if (text.length > CONTEXT_BODY_MAX || target.length > VIEW_TARGET_MAX) view.shortened = true;
    }
  }
  if (step.incomplete === true) view.note = "Uses the result of an earlier step.";
  return view;
}

/**
 * The hash a person approves: the user, the client, a hash of the code, and the digests of the plan's steps that need
 * approval (sorted, so concurrent calls that start in another order give the same plan).
 */
export async function approvalPlanHash(p: { userId: string; clientId: string; code: string; digests: readonly string[] }): Promise<string> {
  return sha256Hex(canonicalJson({ v: 2, userId: p.userId, clientId: p.clientId, code: await sha256Hex(p.code), steps: [...p.digests].sort() }));
}

/** The distinct reasons of `steps`, in list order. */
export function reasonsOf(steps: readonly GatedStep[]): HumanApprovalReason[] {
  return HUMAN_APPROVAL_REASONS.filter((r) => steps.some((s) => s.reason === r));
}

/** The approved steps' digests as a multiset: each approved step may run once. */
export function approvedSteps(steps: readonly GatedStep[]): Map<string, number> {
  const approved = new Map<string, number>();
  for (const s of steps) approved.set(s.digest, (approved.get(s.digest) ?? 0) + 1);
  return approved;
}

/** Whether any step is too large for the page to show in full: such a plan cannot be approved. */
export function tooLargeToReview(steps: readonly { view: ApprovalStepView }[] | readonly ApprovalStepView[]): boolean {
  return steps.some((s) => ("view" in s ? s.view : s).tooLarge === true);
}

// ---- Approvals store port -------------------------------------------------------------------------------

export interface ApprovalClaim {
  planHash: string;
  userId: string;
  clientId: string;
  now: number;
}

/**
 * Approvals the person gave on the approval page. Only a runtime that serves that page provides it; without it a step
 * with a listed reason can never be approved and is refused.
 */
export interface HumanApprovalPort {
  /**
   * Marks one unused approval of this plan hash, user and client, given less than APPROVAL_TTL_MS ago, used, and
   * returns its id; null when none. Only the caller whose change did it gets the id, so two concurrent runs with one
   * approval never both get it.
   */
  readonly claim: (q: ApprovalClaim) => Promise<string | null>;
}

// ---- Links ----------------------------------------------------------------------------------------------

const ApprovalLinkRecord = z.strictObject({
  kind: z.literal(APPROVAL_LINK_PURPOSE),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  executeId: z.string().min(1),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  steps: z.array(ApprovalStepView).min(1),
  /** The plan's other writes, shown as context. */
  context: z.array(ContextStepView).max(CONTEXT_MAX),
  /** Context writes not listed (past CONTEXT_MAX). */
  moreContext: z.number().int().nonnegative(),
  exp: z.number(),
});
export type ApprovalLinkRecord = z.output<typeof ApprovalLinkRecord>;

export interface MintApprovalLinkDeps {
  links: LinkStore;
  /** The public origin the link points to (PUBLIC_BASE_URL). */
  baseUrl: string;
  auth: AuthProps;
  executeId: string;
  now: number;
}

/**
 * Makes an approval link for the plan `planHash` with these steps, bound to the calling user, client and execute.
 * `context` is the plan's other writes, shown beside them.
 */
export async function mintApprovalLink(
  deps: MintApprovalLinkDeps,
  plan: { planHash: string; steps: readonly GatedStep[]; context?: readonly PlanStep[] },
): Promise<{ link: UserLink; record: ApprovalLinkRecord }> {
  const context = plan.context ?? [];
  const record: ApprovalLinkRecord = {
    kind: APPROVAL_LINK_PURPOSE,
    userId: deps.auth.userId,
    clientId: deps.auth.clientId,
    executeId: deps.executeId,
    planHash: plan.planHash,
    steps: plan.steps.map((s) => s.view),
    context: context.slice(0, CONTEXT_MAX).map(contextStep),
    moreContext: Math.max(0, context.length - CONTEXT_MAX),
    exp: deps.now + LINK_TTL_MS,
  };
  const token = newLinkToken();
  await deps.links.put(await linkKey(APPROVAL_LINK_PURPOSE, token), JSON.stringify(record), { expirationTtl: Math.ceil(LINK_TTL_MS / 1000) });
  return { link: { url: `${deps.baseUrl}${APPROVAL_LINK_PATH}?t=${token}`, expiresAt: record.exp }, record };
}

/**
 * The record behind an approval link token and its `linkKey`, without using it, or null when the token is malformed,
 * unknown, expired or unreadable. Whose it is and whether it was used (`isLinkUsed`) is for the caller to check.
 */
export async function peekApprovalLink(links: LinkStore, token: unknown, now: number): Promise<{ record: ApprovalLinkRecord; tokenHash: string } | null> {
  if (!isLinkToken(token)) return null;
  const tokenHash = await linkKey(APPROVAL_LINK_PURPOSE, token);
  const raw = await links.get(tokenHash);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = ApprovalLinkRecord.safeParse(parsed);
  return r.success && r.data.exp > now ? { record: r.data, tokenHash } : null;
}

// ---- What the AI app is told ----------------------------------------------------------------------------

/** Why a plan's steps cannot get an approval link. */
export type NoLinkReason = "dependent" | "no-page" | "link-failed";

/** What to do when a step that needs approval uses the result of a write that has not run yet. */
export const DEPENDENT_NOTE =
  "A step that needs the person's approval uses the result of a write that has not run yet (directly, or inside a helper), so it cannot be approved as planned. Apply that earlier write in its own run first (apply:true), then dry-run the step that needs approval again with the real value to get an approval link";

const NO_LINK_NOTES: Readonly<Record<NoLinkReason, string>> = {
  dependent: DEPENDENT_NOTE,
  "no-page": "This gws-mcp has no page where the person could approve, so these steps cannot run here",
  "link-failed": "The approval link could not be made. Run the dry run again",
};

/** Said with the link when a step is too large for the page: the person can only decline it. */
export const TOO_LARGE_NOTE =
  "A step that needs approval is too large for the person to review in full on the approval page, so it cannot be approved. Split the change into smaller runs (fewer items per request)";

function linkView(link: UserLink): { url: string; expiresAt: string } {
  return { url: link.url, expiresAt: new Date(link.expiresAt).toISOString() };
}

/** What a dry run adds to its output for steps that need approval: the link, or why there is none. */
export function approvalOffer(steps: readonly GatedStep[], made: UserLink | NoLinkReason): ApprovalOffer {
  const reasons = reasonsOf(steps);
  if (typeof made === "string") return { reasons, note: NO_LINK_NOTES[made] };
  return { reasons, ...linkView(made), ...(tooLargeToReview(steps) ? { note: TOO_LARGE_NOTE } : {}) };
}

function reasonWords(reasons: readonly HumanApprovalReason[]): string {
  return reasons.map((r) => DESTRUCTIVE_REASON_WORDS[r]).join("; ");
}

/** The approval flow in plain words, for the error and the execute tool description. */
export const APPROVAL_STEPS_TEXT =
  "they open it signed in to gws-mcp and approve, then run the same code again with apply:true. The approval works once, within 10 minutes, for exactly that plan: any change to the code or its inputs needs a new one";

/**
 * An `apply: true` run that has no approval for its plan: with a fresh link for the person, or with the reason no link
 * can be made. Nothing was written.
 */
export function approvalRequired(steps: readonly GatedStep[], made: UserLink | NoLinkReason): GwsError {
  const reasons = reasonsOf(steps);
  const lead = `This plan has steps that need the person's approval first (${reasonWords(reasons)}). Nothing was changed.`;
  if (typeof made === "string") return new GwsError("GWS_APPROVAL_REQUIRED", `${lead} ${NO_LINK_NOTES[made]}`, { details: { reasons } });
  const tail = tooLargeToReview(steps) ? TOO_LARGE_NOTE : `Give them the link in details.approval: ${APPROVAL_STEPS_TEXT}`;
  return new GwsError("GWS_APPROVAL_REQUIRED", `${lead} ${tail}`, { details: { reasons, approval: { reasons, ...linkView(made) } } });
}

/** A step with a listed reason that the applied run reached without an approval for it. It is not sent. */
export function stepNotApproved(reason: HumanApprovalReason, hasPage: boolean): GwsError {
  const why = hasPage
    ? "it was not in the plan the person approved for this run. Run a dry run of the code to get an approval link. If the step uses the result of an earlier write in the same run, apply that write in its own run first"
    : NO_LINK_NOTES["no-page"];
  return new GwsError("GWS_APPROVAL_REQUIRED", `This step needs the person's approval (${DESTRUCTIVE_REASON_WORDS[reason]}), and ${why}`, {
    details: { reasons: [reason] },
  });
}

// ---- Audit ----------------------------------------------------------------------------------------------

/** The audit `request_id` of an approval link's rows before an approval exists: a prefix of its plan hash. */
function planRef(planHash: string): string {
  return `plan:${planHash.slice(0, 16)}`;
}

/** The audit `request_id` that ties an approval's rows together: the approval's id. */
export function approvalRef(approvalId: string): string {
  return `approval:${approvalId}`;
}

/** The audit row of an approval link being made, in the execute that asked: it changes nothing, so a read. */
export function approvalMintedRow(record: ApprovalLinkRecord, ts: number): AuditRow {
  return row({ execute_id: record.executeId, user_id: record.userId, client_id: record.clientId, fn: "approval.link.minted", effect: "read", applied: 0, ts, request_id: planRef(record.planHash) });
}

/**
 * The audit row of the person approving or declining on the page, under the client and execute that made the link;
 * the fn names the page decision. An approval carries its approval id, a decline the plan hash prefix.
 */
export function approvalDecidedRow(record: ApprovalLinkRecord, decision: { approved: string } | "declined", ts: number): AuditRow {
  const approved = typeof decision === "object";
  return row({
    execute_id: record.executeId,
    user_id: record.userId,
    client_id: record.clientId,
    fn: approved ? "approval.link.approved" : "approval.link.declined",
    effect: "write",
    applied: 1,
    ts,
    request_id: approved ? approvalRef(decision.approved) : planRef(record.planHash),
  });
}

/** The audit row of an approval being used by the applied execute that runs the approved steps. */
export function approvalUsedRow(executeId: string, auth: AuthProps, approvalId: string, ts: number): AuditRow {
  return row({ execute_id: executeId, user_id: auth.userId, client_id: auth.clientId, fn: "approval.used", effect: "write", applied: 1, ts, request_id: approvalRef(approvalId) });
}

function row(r: Pick<AuditRow, "execute_id" | "user_id" | "client_id" | "fn" | "effect" | "applied" | "ts" | "request_id">): AuditRow {
  return { id: crypto.randomUUID(), account_id: null, status: "ok", code: null, duration_ms: 0, upstream_status: null, ...r };
}

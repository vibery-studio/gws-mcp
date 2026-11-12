import { html } from "hono/html";
import { getClient } from "../../auth/clients";
import { getSession, type AppContext, type Session } from "../../auth/session";
import { DESTRUCTIVE_REASON_WORDS } from "../../core/destructive";
import {
  APPROVAL_LINK_PATH,
  approvalDecidedRow,
  bodyLines,
  hasNonAsciiLetters,
  peekApprovalLink,
  tooLargeToReview,
  visibleText,
  type ApprovalLinkRecord,
  type ApprovalStepView,
  type ContextStepView,
} from "../../core/human-approval";
import { isLinkUsed } from "../../core/links";
import { openApprovals } from "../../store/approvals";
import { COPY } from "../copy";
import { field, messagePage, pageHeaders, posted, sendPage, toLogin } from "../http";
import { loadReadModel } from "../read-model";
import { renderPage, type ShellUser } from "../ui";

/**
 * GET and POST /plan/approve?t=…: the page of an approval link (see src/core/human-approval.ts). An AI app's plan has
 * steps that need the person's own approval (GWS_HUMAN_APPROVAL); the AI app hands the person this link, and they
 * approve or decline the exact steps here.
 *
 * The same rules as the setting link page: the link alone grants nothing; without a session the browser signs in first
 * and comes back; only the user the link was made for may use it, and anyone else gets exactly the refusal of a used,
 * expired or unknown link (and the link stays unused for its owner). The POST goes through the shared form guard
 * (session, this site's Origin, CSRF). Approving records the approval in one transaction with the link's use and the
 * audit row; declining only uses the link. Every response has the signed-in page headers (`no-store`,
 * `Referrer-Policy: same-origin`).
 *
 * What the person approves is shown in full or not offered: a step too large to show gives a "split the change"
 * message and no Approve button, and the POST refuses to approve it. Every value is shown with its invisible and
 * direction-changing characters written out (⟦U+202E⟧), and a value with letters outside A–Z is marked. Names of the
 * targets (file names, campaign names) are not looked up: the page shows ids as the request has them.
 */

export const APPROVAL_LINK_COPY = {
  title: "Approve what your AI app wants to do",
  lede: "Your AI app wants to make changes that need your approval first. Nothing happens until you approve. If you do, your AI app can run exactly these steps, once.",
  app: "Asked by",
  unknownApp: "an AI app you no longer allow",
  needsApproval: "Needs your approval",
  account: "Google account",
  what: "What",
  where: "Where",
  sends: "What it sends",
  context: "Also in this change (no approval needed)",
  contextMore: (n: number) => `And ${n} more changes like these.`,
  shortened: "(shortened here)",
  lettersWarning: "This contains letters that are not plain A to Z. Some look exactly like other letters, so check it carefully.",
  hiddenNote: "Hidden or direction-changing characters are written out like ⟦U+202E⟧.",
  approve: "Approve",
  decline: "Decline",
  once: "This link works once, only for you, and ends 10 minutes after your AI app made it. An approval can be used once, within 10 minutes.",
  tooLargeTitle: "Too large to review here",
  tooLarge: "Part of this change is too large to show here in full, so it can't be approved. Ask your AI app to split it into smaller changes. You can decline this one.",
  invalidTitle: "Link not valid",
  invalid:
    "This link expired, was already used, isn't for the account you're signed in with, or isn't valid. Nothing was approved. Ask your AI app for a new one.",
  choiceTitle: "Request refused",
  choice: "Choose Approve or Decline on the page.",
  approvedTitle: "Approved",
  approved: "Your AI app can now run these steps once, within the next 10 minutes. You can close this page and go back to your AI app.",
  declinedTitle: "Declined",
  declined: "Nothing was approved, and this link no longer works. You can close this page and go back to your AI app.",
} as const;

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The warning under a value whose letters are not all plain A–Z. */
function lettersWarning(text: string) {
  return hasNonAsciiLetters(text) ? html`<p class="small muted">${APPROVAL_LINK_COPY.lettersWarning}</p>` : "";
}

/** A labelled value: its hidden characters written out, isolated from the text around it, and marked when needed. */
function labelled(label: string, value: string) {
  return html`<p>${label}: <bdi class="mono">${visibleText(value)}</bdi></p>
${lettersWarning(value)}`;
}

/** An indented JSON body, one line per line, hidden characters written out. */
function bodyBlock(body: string, shortened: boolean) {
  const lines = bodyLines(body).map((l) => l.replace(/^ +/, (spaces) => " ".repeat(spaces.length)));
  return html`<p>${APPROVAL_LINK_COPY.sends}:</p>
<p><bdi class="mono small">${lines.map((l, i) => (i === 0 ? html`${l}` : html`<br>${l}`))}</bdi>${shortened ? html` <span class="muted">${APPROVAL_LINK_COPY.shortened}</span>` : ""}</p>
${lettersWarning(body)}`;
}

function stepItem(s: ApprovalStepView) {
  return html`<li class="card">
<div class="card-head"><h3 class="card-name">${capitalized(DESTRUCTIVE_REASON_WORDS[s.reason])}</h3></div>
${labelled(APPROVAL_LINK_COPY.account, s.account)}
${labelled(APPROVAL_LINK_COPY.what, s.fn)}
${s.tooLarge === true ? html`<p><strong>${APPROVAL_LINK_COPY.tooLargeTitle}</strong></p>` : labelled(APPROVAL_LINK_COPY.where, `${s.method} ${s.target}`)}
${s.tooLarge !== true && s.body !== undefined ? bodyBlock(s.body, false) : ""}
</li>`;
}

function contextItem(s: ContextStepView) {
  return html`<li class="card card-wash">
${labelled(APPROVAL_LINK_COPY.what, s.fn)}
${s.account !== undefined ? labelled(APPROVAL_LINK_COPY.account, s.account) : ""}
${s.method !== undefined && s.target !== undefined ? labelled(APPROVAL_LINK_COPY.where, `${s.method} ${s.target}`) : ""}
${s.body !== undefined ? bodyBlock(s.body, s.shortened === true) : ""}
${s.note !== undefined ? html`<p class="muted small">${s.note}</p>` : ""}
</li>`;
}

export interface ApprovalLinkPageInput {
  user: ShellUser;
  /** The AI app that asked: its registered name, or undefined when it is no longer allowed. */
  appName: string | undefined;
  steps: readonly ApprovalStepView[];
  context: readonly ContextStepView[];
  moreContext: number;
  /** The link token, posted back in a hidden field. */
  token: string;
}

export function renderApprovalLinkPage(p: ApprovalLinkPageInput): Promise<string> {
  const tooLarge = tooLargeToReview(p.steps);
  return renderPage({
    title: APPROVAL_LINK_COPY.title,
    user: p.user,
    body: html`<h1 class="title">${APPROVAL_LINK_COPY.title}</h1>
<p class="lede">${APPROVAL_LINK_COPY.lede}</p>
<p>You're signed in as <bdi class="mono">${visibleText(p.user.email)}</bdi>.</p>
${p.appName === undefined ? html`<p>${APPROVAL_LINK_COPY.app}: ${APPROVAL_LINK_COPY.unknownApp}</p>` : labelled(APPROVAL_LINK_COPY.app, p.appName)}
<p class="muted small">${APPROVAL_LINK_COPY.hiddenNote}</p>
<h2>${APPROVAL_LINK_COPY.needsApproval}</h2>
<ul class="list">${p.steps.map(stepItem)}</ul>
${
  p.context.length > 0 || p.moreContext > 0
    ? html`<h2>${APPROVAL_LINK_COPY.context}</h2>
<ul class="list">${p.context.map(contextItem)}</ul>
${p.moreContext > 0 ? html`<p class="muted">${APPROVAL_LINK_COPY.contextMore(p.moreContext)}</p>` : ""}`
    : ""
}
${tooLarge ? html`<div class="card card-wash"><h2>${APPROVAL_LINK_COPY.tooLargeTitle}</h2><p>${APPROVAL_LINK_COPY.tooLarge}</p></div>` : ""}
<form method="post" action="${APPROVAL_LINK_PATH}"><input type="hidden" name="csrf" value="${p.user.csrf}"><input type="hidden" name="t" value="${p.token}">
<div class="actions">${tooLarge ? "" : html`<button type="submit" name="decision" value="approve" class="btn btn-primary">${APPROVAL_LINK_COPY.approve}</button>`}<button type="submit" name="decision" value="decline" class="btn btn-ghost">${APPROVAL_LINK_COPY.decline}</button><a class="btn btn-ghost" href="/">${COPY.actions.cancel}</a></div>
</form>
<p class="muted small">${APPROVAL_LINK_COPY.once}</p>`,
  });
}

/** The one refusal for a link that is malformed, unknown, expired, used, or another user's. */
const notValid = (c: AppContext) => messagePage(c, 400, APPROVAL_LINK_COPY.invalidTitle, APPROVAL_LINK_COPY.invalid);

/**
 * The link behind `token` for the signed-in `session`, or the one refusal: not valid (malformed, unknown, expired, used,
 * or another user's; another user's link stays unused). Never uses it.
 */
async function usableLink(c: AppContext, session: Session, token: unknown): Promise<{ record: ApprovalLinkRecord; tokenHash: string } | Response> {
  const link = await peekApprovalLink(c.env.CACHE_KV, token, Date.now());
  if (!link || link.record.userId !== session.userId) return notValid(c);
  // `used_links` is the authority: KV may still serve a used link's record for a while after it is deleted.
  if (await isLinkUsed(c.env.DB, link.tokenHash)) return notValid(c);
  return link;
}

/** GET /plan/approve?t=…: the steps to approve, for the user the link was made for. Reading the link does not use it. */
export async function approvalLinkPage(c: AppContext): Promise<Response> {
  const session = await getSession(c);
  if (!session) {
    // Checked before the link is read: signing in first does not use it up, and the browser comes back to it.
    pageHeaders(c);
    return toLogin(c);
  }
  const token = c.req.query("t");
  const link = await usableLink(c, session, token);
  if (link instanceof Response) return link;
  const { record } = link;
  const [model, app] = await Promise.all([loadReadModel(c.env, session.userId), getClient(c.env, session.userId, record.clientId)]);
  const page = await renderApprovalLinkPage({
    user: { email: model.signedInEmail, csrf: session.csrf },
    appName: app?.clientName,
    steps: record.steps,
    context: record.context,
    moreContext: record.moreContext,
    token: token ?? "",
  });
  return sendPage(c, page, 200);
}

/**
 * POST /plan/approve: fields `t` (the link token) and `decision` (`approve` or `decline`). The link is checked again;
 * a plan too large to show in full is never approved (the link stays usable, for a decline). The decision is written
 * in one transaction with the link's use and its audit row, so a concurrent or later second use changes nothing and
 * gets the not-valid refusal. Once done, only the best-effort removal of the link's record follows.
 */
export async function decideFromApprovalLink(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  const decision = field(form, "decision");
  if (decision !== "approve" && decision !== "decline") return messagePage(c, 400, APPROVAL_LINK_COPY.choiceTitle, APPROVAL_LINK_COPY.choice);
  const link = await usableLink(c, session, field(form, "t"));
  if (link instanceof Response) return link;
  const { record, tokenHash } = link;
  if (decision === "approve" && tooLargeToReview(record.steps)) return messagePage(c, 400, APPROVAL_LINK_COPY.tooLargeTitle, APPROVAL_LINK_COPY.tooLarge);
  const now = Date.now();
  const approvals = openApprovals(c.env);
  let result;
  if (decision === "approve") {
    const id = crypto.randomUUID();
    result = await approvals.approve({ id, tokenHash, userId: record.userId, clientId: record.clientId, planHash: record.planHash, now, audit: approvalDecidedRow(record, { approved: id }, now) });
  } else {
    result = await approvals.decline({ tokenHash, userId: record.userId, now, audit: approvalDecidedRow(record, "declined", now) });
  }
  if (result === "used") return notValid(c);
  // The record only lets the page show the steps; `used_links` already refuses the link everywhere.
  await c.env.CACHE_KV.delete(tokenHash).catch(() => undefined);
  return decision === "approve"
    ? messagePage(c, 200, APPROVAL_LINK_COPY.approvedTitle, APPROVAL_LINK_COPY.approved)
    : messagePage(c, 200, APPROVAL_LINK_COPY.declinedTitle, APPROVAL_LINK_COPY.declined);
}

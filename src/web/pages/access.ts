import { html } from "hono/html";
import { addRule, removeRuleAndRevoke } from "../../auth/access";
import type { AppContext } from "../../auth/session";
import type { AccessRuleView } from "../../contracts";
import { MAX_NOTE } from "../../core/access-capability";
import { isGwsError } from "../../errors";
import { openAccessStore } from "../../store/access";
import { ACCESS_COPY, ACCESS_PATH } from "../access-copy";
import { setFlash, type Flash } from "../flash";
import { field, genericFlash, messagePage, notFoundPage, pageContext, posted, sendPage, signedIn } from "../http";
import type { ReadModel } from "../read-model";
import { chip, renderPage, type FlashMessage, type Html, type ShellUser } from "../ui";

/**
 * GET /access and its two actions (admins only): the list of who may use this gws-mcp, a form to add an email or a
 * whole domain with a role, a role switch and a remove per rule. Every route reads the caller's role fresh from the
 * store (never the nav flag, never the cache) and answers anyone who is not an admin as if the page did not exist.
 * The POSTs sit behind the shared session, Origin and CSRF guard; their results come back as a flash (post/redirect/
 * get) that never carries the rule itself.
 */

export interface AccessPageInput {
  user: ShellUser;
  rules: readonly AccessRuleView[];
  flash: FlashMessage | null;
}

/** The code on an `access-removed` flash whose provider cleanup did not finish. */
const CLEANUP_INCOMPLETE = "cleanup_incomplete";

/** Flash codes this page words itself (failed changes). */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  last_admin: ACCESS_COPY.lastAdmin,
  bad_pattern: ACCESS_COPY.badPattern,
  conflict: ACCESS_COPY.conflict,
};

export function accessFlash(flash: Flash, model: ReadModel): FlashMessage {
  if (flash.kind === "access-saved") return { tone: "success", text: ACCESS_COPY.saved };
  if (flash.kind === "access-removed") {
    return flash.code === CLEANUP_INCOMPLETE ? { tone: "warning", text: ACCESS_COPY.removedPartly } : { tone: "success", text: ACCESS_COPY.removed };
  }
  const known = flash.kind === "error" && flash.code !== undefined ? ERROR_TEXT[flash.code] : undefined;
  return known !== undefined ? { tone: "error", text: known } : genericFlash(flash, model);
}

function hidden(csrf: string, pattern: string): Html {
  return html`<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="pattern" value="${pattern}">`;
}

function ruleItem(r: AccessRuleView, csrf: string): Html {
  const other = r.role === "admin" ? "user" : "admin";
  return html`<li class="card">
<div class="card-head"><h2 class="card-name"><span class="mono">${r.pattern}</span></h2><span class="chips">${chip(r.role === "admin" ? "ok" : "plain", ACCESS_COPY.roles[r.role])}</span></div>
<p class="muted">${ACCESS_COPY.kinds[r.kind]}</p>
${r.note !== undefined ? html`<p class="muted"><bdi>${r.note}</bdi></p>` : ""}
<div class="actions"><form method="post" action="${ACCESS_PATH}/add" class="inline">${hidden(csrf, r.pattern)}<input type="hidden" name="role" value="${other}"><button type="submit" class="btn btn-ghost">${other === "admin" ? ACCESS_COPY.makeAdmin : ACCESS_COPY.makeUser}</button></form>
<form method="post" action="${ACCESS_PATH}/remove" class="inline">${hidden(csrf, r.pattern)}<button type="submit" class="btn btn-danger">${ACCESS_COPY.remove}</button></form></div>
</li>`;
}

function addForm(csrf: string): Html {
  return html`<form method="post" action="${ACCESS_PATH}/add" class="card card-wash"><input type="hidden" name="csrf" value="${csrf}">
<h2>${ACCESS_COPY.addHeading}</h2>
<div class="field">
<label for="access-pattern">${ACCESS_COPY.patternLabel}</label>
<p class="hint" id="access-pattern-hint">${ACCESS_COPY.patternHint}</p>
<input type="text" id="access-pattern" name="pattern" maxlength="320" autocomplete="off" required aria-describedby="access-pattern-hint">
</div>
<fieldset class="field">
<legend>${ACCESS_COPY.roleLabel}</legend>
<label class="check"><input type="radio" name="role" value="user" checked><span class="check-body"><span>${ACCESS_COPY.roleOptions.user}</span></span></label>
<label class="check"><input type="radio" name="role" value="admin"><span class="check-body"><span>${ACCESS_COPY.roleOptions.admin}</span></span></label>
</fieldset>
<div class="field">
<label for="access-note">${ACCESS_COPY.noteLabel}</label>
<p class="hint" id="access-note-hint">${ACCESS_COPY.noteHint}</p>
<input type="text" id="access-note" name="note" maxlength="${MAX_NOTE}" autocomplete="off" aria-describedby="access-note-hint">
</div>
<div class="actions"><button type="submit" class="btn btn-primary">${ACCESS_COPY.add}</button></div>
</form>`;
}

export function renderAccessPage(p: AccessPageInput): Promise<string> {
  return renderPage({
    title: ACCESS_COPY.title,
    user: p.user,
    current: "access",
    flash: p.flash,
    body: html`<h1 class="title">${ACCESS_COPY.title}</h1>
<p class="lede">${ACCESS_COPY.lede}</p>
<p class="muted">${ACCESS_COPY.adminsNote} ${ACCESS_COPY.moreAccounts}</p>
<div class="stack">
<h2>${ACCESS_COPY.listHeading}</h2>
${p.rules.length > 0 ? html`<ul class="list">${p.rules.map((r) => ruleItem(r, p.user.csrf))}</ul>` : html`<p>${ACCESS_COPY.empty}</p>`}
<p class="muted small">${ACCESS_COPY.removeHint}</p>
${addForm(p.user.csrf)}
</div>`,
  });
}

/**
 * Whether the user is an admin, read fresh from the store. A failed read throws, so the request fails (500) rather
 * than falling open.
 */
async function isAdmin(c: AppContext, userId: string): Promise<boolean> {
  return (await openAccessStore(c.env.DB).roleForUser(userId)) === "admin";
}

export async function accessPage(c: AppContext): Promise<Response> {
  const session = signedIn(c);
  if (!(await isAdmin(c, session.userId))) return notFoundPage(c);
  const [ctx, rules] = await Promise.all([pageContext(c, session), openAccessStore(c.env.DB).list()]);
  const views = rules.map(({ createdBy: _createdBy, ...view }) => view);
  return sendPage(c, await renderAccessPage({ user: ctx.user, rules: views, flash: ctx.flash ? accessFlash(ctx.flash, ctx.model) : null }));
}

/** The flash code of a refused change, or null for any other failure (rethrown). */
function refusalCode(e: unknown): string | null {
  if (!isGwsError(e) || e.code !== "GWS_INVALID_INPUT") return null;
  const reason = e.details?.reason;
  if (reason === "last_admin" || reason === "conflict") return reason;
  return "bad_pattern";
}

async function done(c: AppContext, userId: string, flash: Flash): Promise<Response> {
  await setFlash(c, userId, flash);
  return c.redirect(ACCESS_PATH, 303);
}

/** POST /access/add (fields `pattern`, `role`, optional `note`): adds a rule, or sets an existing rule's role. */
export async function addAccessRule(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  if (!(await isAdmin(c, session.userId))) return notFoundPage(c);
  const note = field(form, "note")?.trim();
  try {
    await addRule(c.env, { pattern: field(form, "pattern"), role: field(form, "role"), ...(note ? { note } : {}) }, { actor: session.userId, via: "web" });
  } catch (e) {
    const code = refusalCode(e);
    if (code === null) throw e;
    return done(c, session.userId, { tone: "error", kind: "error", code });
  }
  return done(c, session.userId, { tone: "success", kind: "access-saved" });
}

/** POST /access/remove (field `pattern`): removes a rule and ends the AI app access of everyone it shuts out. */
export async function removeAccessRule(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  if (!(await isAdmin(c, session.userId))) return notFoundPage(c);
  const pattern = field(form, "pattern");
  if (pattern === undefined) return messagePage(c, 400, "Nothing chosen", ACCESS_COPY.badPattern);
  let appsFailed: number;
  try {
    ({ appsFailed } = await removeRuleAndRevoke(c.env, pattern, { actor: session.userId, via: "web" }));
  } catch (e) {
    const code = refusalCode(e);
    if (code === null) throw e;
    return done(c, session.userId, { tone: "error", kind: "error", code });
  }
  return done(
    c,
    session.userId,
    appsFailed > 0 ? { tone: "warning", kind: "access-removed", code: CLEANUP_INCOMPLETE } : { tone: "success", kind: "access-removed" },
  );
}

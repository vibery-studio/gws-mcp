import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { csrfMatches, getSession, type AppContext, type Session } from "../auth/session";
import { loadConfig } from "../config";
import { COPY, plainError } from "./copy";
import { takeFlash, type Flash } from "./flash";
import { loadReadModel, type ReadModel } from "./read-model";
import { PAGE_CSP, PAGE_REFERRER_POLICY, renderMessagePage, type FlashMessage, type ShellUser } from "./ui";

/**
 * Request plumbing shared by the signed-in pages and their actions: response headers, the session gate of
 * every page, the session + Origin + CSRF guard of every POST, form field access and the per-page context.
 * Page modules import it; only `connections.ts` registers routes and middleware.
 */

export type Form = Record<string, string | File | (string | File)[]>;

/** The longest account or app id accepted from a path or form (the stores' own bound). */
const MAX_ID = 256;

/** Headers of every signed-in page: no framing, no caching, no script; a referrer policy that keeps Origin on POSTs. */
export function pageHeaders(c: AppContext): void {
  c.header("Content-Security-Policy", PAGE_CSP);
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", PAGE_REFERRER_POLICY);
}

/** Sends a rendered page with the page headers. */
export function sendPage(c: AppContext, page: string, status: ContentfulStatusCode = 200): Response {
  pageHeaders(c);
  return c.html(page, status);
}

export async function messagePage(c: AppContext, status: ContentfulStatusCode, title: string, message: string): Promise<Response> {
  return sendPage(c, await renderMessagePage(title, message), status);
}

/** The answer for an account or app id that is not the user's (or does not exist): the same either way. */
export function notFoundPage(c: AppContext): Promise<Response> {
  return messagePage(c, 404, "Not found", "This page doesn't exist, or it isn't one of yours.");
}

/** Sends a browser without a session to sign in, coming back to this exact page. */
export function toLogin(c: AppContext): Response {
  const url = new URL(c.req.url);
  return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
}

/** An id from a path or form, or undefined when absent or overlong. */
export function boundedId(id: string | undefined): string | undefined {
  return id === undefined || id.length === 0 || id.length > MAX_ID ? undefined : id;
}

/** Exactly one string value of a form field, else undefined. */
export function field(form: Form, name: string): string | undefined {
  const v = form[name];
  return typeof v === "string" ? v : undefined;
}

/** Every string value of a repeated form field. */
export function fields(form: Form, name: string): string[] {
  const v = form[name];
  const values = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return values.filter((x): x is string => typeof x === "string");
}

// ---- Gates ------------------------------------------------------------------------------------------

/** Requests that passed a gate, with what the gate read. Keyed by the request, so nothing leaks across requests. */
const signedInRequests = new WeakMap<Request, Session>();
const checkedPosts = new WeakMap<Request, { session: Session; form: Form }>();

/** GET gate of every signed-in page: no session, sign in first and come back. */
export const requireSignedIn: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const session = await getSession(c);
  if (!session) return toLogin(c);
  signedInRequests.set(c.req.raw, session);
  await next();
};

/** The session `requireSignedIn` found. Fails closed: a page not behind the gate throws. */
export function signedIn(c: AppContext): Session {
  const session = signedInRequests.get(c.req.raw);
  if (!session) throw new Error("page reached a handler without the session gate");
  return session;
}

/** POST gate: a session, this site's Origin, and the session's CSRF token, before anything else runs. */
export const guardPost: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const session = await getSession(c);
  if (!session) return messagePage(c, 401, "Signed out", "Your session ended. Sign in and try again.");
  if (c.req.header("origin") !== loadConfig(c.env).PUBLIC_BASE_URL) {
    return messagePage(c, 403, "Request refused", "This form did not come from this site.");
  }
  const form = (await c.req.parseBody({ all: true })) as Form;
  if (!csrfMatches(session, form.csrf)) return messagePage(c, 403, "Request refused", "This form did not come from this site.");
  checkedPosts.set(c.req.raw, { session, form });
  await next();
};

/** The checked session and form of this POST. Fails closed: a handler not behind the guard throws. */
export function posted(c: AppContext): { session: Session; form: Form } {
  const checked = checkedPosts.get(c.req.raw);
  if (!checked) throw new Error("POST reached a handler without the session, Origin and CSRF checks");
  return checked;
}

// ---- Page context -----------------------------------------------------------------------------------

/** What every signed-in page renders from. */
export interface PageContext {
  session: Session;
  /** For the shell: the signed-in email and the sign-out form's CSRF token. */
  user: ShellUser;
  model: ReadModel;
  /** The waiting flash, already used up; the page words it. */
  flash: Flash | null;
}

/** Loads the read model and takes the flash for the session's user. Call it once per page view. */
export async function pageContext(c: AppContext, session: Session): Promise<PageContext> {
  const [model, flash] = await Promise.all([loadReadModel(c.env, session.userId), takeFlash(c, session.userId)]);
  return { session, user: { email: model.signedInEmail, csrf: session.csrf }, model, flash };
}

/**
 * Fallback wording for a flash a page has no words of its own for: an error in plain words (naming the
 * account when the flash points at one of the user's), anything else as saved.
 */
export function genericFlash(flash: Flash, model: ReadModel): FlashMessage {
  if (flash.kind === "error") {
    const account = flash.accountId === undefined ? undefined : model.account(flash.accountId);
    return { tone: "error", text: plainError(flash.code ?? "", account?.name) };
  }
  return { tone: flash.tone, text: COPY.flash.saved };
}

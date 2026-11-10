import { html, raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getClient } from "../../auth/clients";
import type { AppContext } from "../../auth/session";
import { openStore } from "../../store/db";
import { COPY, SERVICE_NAMES } from "../copy";
import { setFlash, type Flash } from "../flash";
import { boundedId, field, fields, genericFlash, notFoundPage, pageContext, posted, sendPage, signedIn } from "../http";
import { loadReadModel, type AccountView, type AppView, type ReadModel } from "../read-model";
import { chip, checkbox, linkButton, renderPage, statusChip, type FlashMessage, type Html, type ShellUser } from "../ui";

/** GET /apps/:id (one AI app's allowed accounts) and POST /apps/:id/access (save them). */

export interface AppDetailsPageInput {
  user: ShellUser;
  model: ReadModel;
  app: AppView;
  flash: FlashMessage | null;
  /** After a refused save: the accounts the user had checked (shown checked again) and why it was refused. */
  refused?: { accountIds: readonly string[]; error: string };
}

/** What happens when an AI app names no account and the default isn't one it may use. */
const DEFAULT_NOT_ALLOWED =
  "Your AI uses the default account when it doesn't name one, but only if that AI app is allowed to use it. Otherwise the request is refused; it never switches to another account.";

const appPath = (id: string) => `/apps/${encodeURIComponent(id)}`;

/** Hidden field of the access form: the account ids it showed as allowed, space-separated (ids hold no spaces). */
const SHOWN_FIELD = "shown";
const OUT_OF_DATE = "This page was out of date. Review and save again.";

/** Wording of the flashes that land on this page: the app's saved access. */
export function appDetailsFlash(flash: Flash, model: ReadModel): FlashMessage {
  const app = flash.kind === "app-access-saved" && flash.appId !== undefined ? model.app(flash.appId) : undefined;
  if (!app) return genericFlash(flash, model);
  const allowed = model.allowedAccounts(app.id);
  if (allowed.length === 0) return { tone: "warning", text: `Saved. ${COPY.trust.appStaysApprovedWithoutAccounts(app.name)}` };
  return { tone: "success", text: `Saved. ${app.name} is allowed to use ${allowed.map((a) => a.name).join(", ")}.` };
}

function services(a: AccountView): string {
  return a.services.length > 0 ? a.services.map((s) => SERVICE_NAMES[s]).join(", ") : "No Google services connected yet.";
}

/** Why an account can't be used right now, or can't be newly allowed, in plain words. */
function accountNote(a: AccountView, allowed: boolean, appName: string): string | undefined {
  if (a.status === "active") return undefined;
  if (!allowed) return "Reconnect this account before you allow it.";
  return a.status === "reconnect"
    ? `Google needs you to reconnect this account before ${appName} can use it.`
    : `Reconnecting this account removes it from ${appName}; you can allow it again afterwards.`;
}

function accountRow(a: AccountView, app: AppView, checked: boolean): Html {
  const allowed = app.allowedAccountIds.includes(a.id);
  const note = accountNote(a, allowed, app.name);
  const label = html`<bdi>${a.name}</bdi>`;
  const detail = html`${a.alias !== undefined ? html`<span class="mono small muted">${a.email}</span>` : ""}<span class="chips">${statusChip(a.status)}${
    a.isDefault ? chip("default", COPY.chips.default) : ""
  }</span><span class="hint">${services(a)}</span>${note ? html`<span class="hint">${note}</span>` : ""}`;
  // A connected account, or one already allowed (its row may be kept or removed), can be chosen; any other
  // can't be newly allowed until it is reconnected, so its box is shown but disabled and never submitted.
  if (a.status === "active" || allowed) return checkbox({ name: "account", value: a.id, label, detail, checked });
  return html`<label class="check"><input type="checkbox" value="${a.id}" disabled><span class="check-body"><span>${label}</span>${detail}</span></label>`;
}

export function renderAppDetailsPage(p: AppDetailsPageInput): Promise<string> {
  const { app, model } = p;
  const path = appPath(app.id);
  const name = html`<bdi>${app.name}</bdi>`;
  const checked = new Set(p.refused?.accountIds ?? app.allowedAccountIds);
  // A disconnected account shows only while this app still has it: reconnecting clears that row.
  const accounts = model.accounts.filter((a) => a.status !== "disconnected" || app.allowedAccountIds.includes(a.id));
  const defaultAccount = model.accounts.find((a) => a.isDefault);
  const hints = [
    `These choices apply only to ${app.name}. Other AI apps keep their own access settings.`,
    COPY.trust.defaultIsNotAccess,
    ...(defaultAccount && !app.allowedAccountIds.includes(defaultAccount.id) ? [DEFAULT_NOT_ALLOWED] : []),
    ...(app.allowedAccountIds.length === 0 ? [COPY.trust.appStaysApprovedWithoutAccounts(app.name)] : []),
  ];
  return renderPage({
    title: app.name,
    user: p.user,
    current: "apps",
    crumbs: [{ href: "/apps", label: COPY.nav.apps }, { label: app.name }],
    flash: p.flash,
    body: html`<h1 class="title">${name}</h1>
<p class="lede">Choose which Google accounts ${name} can use.</p>
<p class="small muted">${COPY.trust.appNameNotVerified}</p>
${
  accounts.length > 0
    ? html`<form method="post" action="${path}/access"><input type="hidden" name="csrf" value="${p.user.csrf}"><input type="hidden" name="${SHOWN_FIELD}" value="${app.allowedAccountIds.join(" ")}">
<fieldset${p.refused ? raw(' aria-describedby="access-error"') : ""}>
<legend>Allowed Google accounts</legend>
${p.refused ? html`<p class="field-error" id="access-error" role="alert">${p.refused.error}</p>` : ""}
${accounts.map((a) => accountRow(a, app, checked.has(a.id)))}
</fieldset>
${hints.map((h) => html`<p class="hint">${h}</p>`)}
<div class="actions"><button type="submit" class="btn btn-primary">${COPY.actions.saveChanges}</button>${linkButton(path, COPY.actions.cancel)}</div>
</form>`
    : html`<p>${COPY.empty.noAccounts}</p><div class="actions">${linkButton("/accounts", COPY.actions.viewAccounts)}</div>`
}
<h2>Before changes are made</h2>
<p>${COPY.trust.writeGuard}</p>
<p class="muted">${COPY.trust.servicesFollowAccount}</p>
<h2>Remove ${name}'s access</h2>
<p>${name} will no longer be approved to use your Google accounts through ${COPY.product}. Your Google accounts will stay connected.</p>
<div class="actions">${linkButton(`${path}/remove`, COPY.actions.removeAiApp, "danger")}</div>`,
  });
}

export async function appDetailsPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const id = boundedId(c.req.param("id"));
  const app = id === undefined ? undefined : ctx.model.app(id);
  if (!app) return notFoundPage(c);
  return sendPage(c, await renderAppDetailsPage({ user: ctx.user, model: ctx.model, app, flash: ctx.flash ? appDetailsFlash(ctx.flash, ctx.model) : null }));
}

/**
 * POST /apps/:id/access: repeated field `account`, the complete set the app may use (possibly none).
 *
 * This is the signed-in human's own form (session, Origin and CSRF checked by `guardPost`), so it applies
 * directly, through the same rules as the per-row actions: it diffs the submitted set against the app's
 * current allowlist, removes what was unchecked (narrowing, always allowed) and adds what was checked, where
 * only a connected account can be newly allowed. An app or account id that is not the user's answers 404
 * and changes nothing.
 *
 * The form carries the allowlist it showed. If that is no longer the current one (a reconnect cleared a row,
 * another tab or a new approval changed it), a box still ticked from then would re-grant access the user never
 * chose again, so the save is refused with 409 and the page shown fresh, changing nothing. The AI app itself has no session here; its own requests only ever reach the
 * confirmation page.
 */
export async function saveAppAccess(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  const userId = session.userId;
  const id = boundedId(c.req.param("id"));
  const client = id === undefined ? null : await getClient(c.env, userId, id);
  if (!client) return notFoundPage(c);

  const store = openStore(c.env);
  const accounts = new Map((await store.accounts.listForUser(userId)).map((a) => [a.id, a]));
  const wanted = new Set(fields(form, "account"));
  if ([...wanted].some((accountId) => !accounts.has(accountId))) return notFoundPage(c);

  const current = new Set(client.accountIds);
  const shown = field(form, SHOWN_FIELD);
  const shownIds = new Set(shown === undefined ? [] : shown.split(" ").filter((x) => x !== ""));
  if (shown === undefined || shownIds.size !== current.size || [...shownIds].some((x) => !current.has(x))) {
    return refuse(c, session, client.clientId, 409, OUT_OF_DATE);
  }

  const added = [...wanted].filter((accountId) => !current.has(accountId));
  const removed = [...current].filter((accountId) => !wanted.has(accountId));
  const notConnected = added.map((accountId) => accounts.get(accountId)).find((a) => a !== undefined && a.status !== "active");
  if (notConnected) {
    return refuse(c, session, client.clientId, 400, (model) => ({
      accountIds: [...wanted],
      error: `Only connected accounts can be newly allowed. Reconnect ${model.account(notConnected.id)?.name ?? notConnected.email} first.`,
    }));
  }

  // Narrowing first: if a later write fails, the app has lost access rather than gained it.
  for (const accountId of removed) await store.grants.remove(userId, client.clientId, accountId);
  for (const accountId of added) await store.grants.add(userId, client.clientId, accountId);
  await setFlash(c, userId, { tone: "success", kind: "app-access-saved", appId: client.clientId });
  return c.redirect(appPath(client.clientId), 303);
}

/**
 * The app's page, freshly read, with a refusal beside the account list. `refusal` is either a message for the
 * page as it stands now, or the message plus the choices to keep checked.
 */
async function refuse(
  c: AppContext,
  session: { userId: string; csrf: string },
  appId: string,
  status: ContentfulStatusCode,
  refusal: string | ((model: ReadModel) => { accountIds: readonly string[]; error: string }),
): Promise<Response> {
  const model = await loadReadModel(c.env, session.userId);
  const app = model.app(appId);
  if (!app) return notFoundPage(c);
  const refused = typeof refusal === "string" ? { accountIds: app.allowedAccountIds, error: refusal } : refusal(model);
  const page = await renderAppDetailsPage({ user: { email: model.signedInEmail, csrf: session.csrf }, model, app, flash: null, refused });
  return sendPage(c, page, status);
}

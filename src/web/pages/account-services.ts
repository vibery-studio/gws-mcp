import { html } from "hono/html";
import { DEFAULT_NEXT, startGoogleAuth } from "../../auth/google-flow";
import type { AppContext, Session } from "../../auth/session";
import { GOOGLE_SERVICES, SERVICE_SCOPES, grantedServices, loadConfig, type GoogleService } from "../../config";
import { openStore } from "../../store/db";
import { COPY, SERVICE_NAMES, serviceDescription } from "../copy";
import { boundedId, fields, genericFlash, notFoundPage, pageContext, posted, sendPage, signedIn } from "../http";
import { loadReadModel, type AccountView, type ReadModel } from "../read-model";
import { checkbox, linkButton, renderPage, type FlashMessage, type Html, type ShellUser } from "../ui";
import { accountName, accountPath } from "./accounts";

/**
 * GET /accounts/:id/services (choose Google services to add) and POST /accounts/:id/services (continue to
 * Google). Only services the account does not have yet can be chosen: services can be added, never removed
 * one by one. Continuing starts the existing connect flow for the chosen services, with the account
 * pre-selected at Google; Google adds them to what the account already has.
 */

export interface AccountServicesPageInput {
  user: ShellUser;
  model: ReadModel;
  account: AccountView;
  flash: FlashMessage | null;
  /** Shown beside the service choices when the last submission was refused. */
  error?: string;
  /** The services the refused submission chose, checked again. */
  chosen?: readonly string[];
}

export const SERVICE_ERRORS = {
  none: "Choose at least one Google service to add.",
  notOffered: "Choose only from the Google services listed.",
} as const;

function serviceItem(preset: ReadModel["preset"], service: GoogleService): Html {
  return html`<li><strong>${SERVICE_NAMES[service]}</strong> <span class="hint">${serviceDescription(preset, service)}</span></li>`;
}

function choiceForm(p: AccountServicesPageInput): Html {
  const a = p.account;
  const chosen = new Set(p.chosen ?? []);
  const choices = a.missingServices.map((s) =>
    checkbox({
      name: "service",
      value: s,
      label: html`${SERVICE_NAMES[s]}`,
      detail: html`<span class="hint">${serviceDescription(p.model.preset, s)}</span>`,
      checked: chosen.has(s),
    }),
  );
  return html`<form method="post" action="${accountPath(a.id, "services")}"><input type="hidden" name="csrf" value="${p.user.csrf}">
<fieldset${p.error ? html` aria-describedby="services-error"` : ""}>
<legend>Google services you can add</legend>
${p.error ? html`<p class="field-error" id="services-error" role="alert">${p.error}</p>` : ""}
${choices}
</fieldset>
<p class="muted small">${COPY.trust.servicesFollowAccount}</p>
<div class="actions"><button type="submit" class="btn btn-primary">${COPY.actions.continueToGoogle}</button><a class="btn btn-ghost" href="${accountPath(a.id)}">${COPY.actions.cancel}</a></div>
</form>`;
}

export function renderAccountServicesPage(p: AccountServicesPageInput): Promise<string> {
  const a = p.account;
  const name = accountName(a);
  return renderPage({
    title: `${COPY.actions.addGoogleServices} · ${a.name}`,
    user: p.user,
    current: "accounts",
    crumbs: [{ href: "/accounts", label: COPY.nav.accounts }, { href: accountPath(a.id), label: a.name }, { label: COPY.actions.addGoogleServices }],
    flash: p.flash,
    body: html`<h1 class="title">Add Google services to ${name}</h1>
<p class="lede">Choose the Google services you want to connect. Google will ask you to review access before these services are added.</p>
<h2>Already connected</h2>
${a.services.length > 0 ? html`<ul class="list">${a.services.map((s) => serviceItem(p.model.preset, s))}</ul>` : html`<p class="muted">No Google services are connected yet.</p>`}
${
  a.missingServices.length > 0
    ? choiceForm(p)
    : html`<p>${COPY.empty.allServicesConnected}</p>
<div class="actions">${linkButton(accountPath(a.id), COPY.actions.backToAccount)}</div>`
}`,
  });
}

export async function accountServicesPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const id = boundedId(c.req.param("id"));
  const account = id === undefined ? undefined : ctx.model.account(id);
  if (!account) return notFoundPage(c);
  return sendPage(c, await renderAccountServicesPage({ user: ctx.user, model: ctx.model, account, flash: ctx.flash ? genericFlash(ctx.flash, ctx.model) : null }));
}

/** The choice page again with the reason beside the choices (400). Nothing was started. */
async function refused(c: AppContext, session: Session, accountId: string, chosen: readonly string[], error: string): Promise<Response> {
  const model = await loadReadModel(c.env, session.userId);
  const account = model.account(accountId);
  if (!account) return notFoundPage(c);
  const page = await renderAccountServicesPage({ user: { email: model.signedInEmail, csrf: session.csrf }, model, account, flash: null, error, chosen });
  return sendPage(c, page, 400);
}

/**
 * POST /accounts/:id/services: repeated field `service`, each one the account does not have yet. Starts the
 * connect flow at Google for exactly those services, pre-selecting the account. Another user's or an unknown
 * account gets the same 404 as its page, and nothing starts.
 */
export async function addAccountServices(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  const id = boundedId(c.req.param("id"));
  const account = id === undefined ? null : await openStore(c.env).accounts.get(session.userId, id);
  if (!account) return notFoundPage(c);

  const preset = loadConfig(c.env).GOOGLE_SCOPE_PRESET;
  const granted = grantedServices(preset, account.scopes);
  const requested = [...new Set(fields(form, "service"))];
  const offered = (s: string): s is GoogleService => (GOOGLE_SERVICES as readonly string[]).includes(s) && !granted[s as GoogleService];
  const services = requested.filter(offered);
  if (requested.length === 0) return refused(c, session, account.id, [], SERVICE_ERRORS.none);
  if (services.length !== requested.length) return refused(c, session, account.id, services, SERVICE_ERRORS.notOffered);

  return startGoogleAuth(c, {
    purpose: "connect",
    userId: session.userId,
    scopes: [...new Set(services.flatMap((s) => SERVICE_SCOPES[preset][s]))],
    loginHint: account.email,
    next: DEFAULT_NEXT,
  });
}

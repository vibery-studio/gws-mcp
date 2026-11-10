import { html, raw } from "hono/html";
import type { AppContext, Session } from "../../auth/session";
import { isGwsError } from "../../errors";
import { openStore } from "../../store/db";
import { COPY, GLOSSARY } from "../copy";
import { setFlash, type Flash } from "../flash";
import { boundedId, field, genericFlash, notFoundPage, pageContext, posted, sendPage, signedIn } from "../http";
import { loadReadModel, type AccountView, type ReadModel } from "../read-model";
import { linkButton, postButton, renderPage, type FlashMessage, type Html, type ShellUser } from "../ui";
import { accountChips, accountName, accountPath, serviceChips } from "./accounts";

/**
 * GET /accounts/:id (one account's details: its name, the default, its Google services, the AI apps that can
 * use it, and the way to disconnect it) and POST /accounts/:id/name (save its account name).
 * Make default posts to the existing POST /connections/set-default; Disconnect leads to the confirmation page.
 */

export interface AccountDetailsPageInput {
  user: ShellUser;
  model: ReadModel;
  account: AccountView;
  flash: FlashMessage | null;
  /** A rejected account name to show again, with the reason beside the field. */
  nameError?: { value: string; message: string };
}

/** The store's own account-name rule (64 characters at most, no "@", no control characters), plus no invisible format characters. */
const NAME_RULE = /^[^@\p{Cc}\p{Cf}]{1,64}$/u;
/** The longest rejected value shown back in the field. */
const MAX_ECHO = 256;

export const NAME_ERRORS = {
  missing: "Enter an account name.",
  invalid: "Use up to 64 characters, without @ or hidden characters.",
  taken: "Another of your accounts already uses this name.",
} as const;

const DEFAULT_RULE =
  "Your AI uses the default account when it doesn't name one, but only if that AI app is allowed to use it. Otherwise the request is refused; it never switches to another account.";

/** Wording of the flashes that land on this page: a rename and a new default. */
export function accountDetailsFlash(flash: Flash, model: ReadModel): FlashMessage {
  const account = flash.accountId === undefined ? undefined : model.account(flash.accountId);
  if (flash.kind === "account-renamed") return { tone: "success", text: "Account name saved." };
  if (flash.kind === "default-set" && account) return { tone: "success", text: `${account.name} is now your default account.` };
  return genericFlash(flash, model);
}

function attention(a: AccountView, name: Html): Html {
  const why = a.status === "reconnect" ? html`${GLOSSARY.needsReconnecting.explain}` : html`${name} is disconnected. Your AI apps can't use it until you reconnect it.`;
  return html`<div class="card card-wash"><p>${why}</p><div class="actions">${linkButton(accountPath(a.id, "reconnect"), COPY.actions.reconnect, "primary")}</div></div>`;
}

function nameForm(p: AccountDetailsPageInput): Html {
  const err = p.nameError;
  const value = err?.value ?? p.account.alias ?? "";
  return html`<form method="post" action="${accountPath(p.account.id)}/name"><input type="hidden" name="csrf" value="${p.user.csrf}">
<div class="field">
<label for="account-name">What would you like to call this account?</label>
<p class="hint" id="account-name-hint">This name helps you recognize the account. It does not change your Google account.</p>
${err ? html`<p class="field-error" id="account-name-error">${err.message}</p>` : ""}
<input type="text" id="account-name" name="alias" value="${value}" maxlength="64" autocomplete="off" aria-describedby="account-name-hint${err ? " account-name-error" : ""}"${err ? raw(' aria-invalid="true"') : ""}>
</div>
<button type="submit" class="btn btn-primary">${COPY.actions.saveName}</button>
</form>`;
}

function defaultSection(p: AccountDetailsPageInput, name: Html): Html {
  const a = p.account;
  const current = p.model.accounts.find((x) => x.isDefault);
  const which = a.isDefault
    ? html`${name} is your default account.`
    : current
      ? html`Your default account is ${accountName(current)}.`
      : html`No default account is set.`;
  // The existing endpoint refuses a disconnected account, so the action is not offered for one.
  const makeDefault =
    !a.isDefault && a.status !== "disconnected"
      ? html`<div class="actions">${postButton({ csrf: p.user.csrf, action: "/connections/set-default", label: COPY.actions.makeDefault, fields: { account: a.id } })}</div>`
      : "";
  return html`<h2>${GLOSSARY.defaultAccount.term}</h2>
<p>${which}</p>
<p class="muted">${DEFAULT_RULE}</p>
<p class="muted small">${COPY.trust.defaultIsNotAccess}</p>
${makeDefault}`;
}

function servicesSection(a: AccountView): Html {
  return html`<h2>${GLOSSARY.googleServices.term}</h2>
<p class="muted">These are the parts of this Google account you have connected.</p>
${a.services.length > 0 ? serviceChips(a.services, GLOSSARY.googleServices.term) : html`<p>No Google services are connected.</p>`}
${
  a.missingServices.length > 0
    ? html`<div class="actions">${linkButton(accountPath(a.id, "services"), COPY.actions.addGoogleServices)}</div>`
    : html`<p class="muted">${COPY.empty.allServicesConnected}</p>`
}
<p class="muted small">${COPY.trust.servicesAddOnly}</p>`;
}

function appsSection(a: AccountView, name: Html): Html {
  const apps = a.allowedFor;
  return html`<h2>AI apps that can use ${name}</h2>
${
  apps.length > 0
    ? html`<ul class="list">${apps.map((app) => html`<li><a href="/apps/${encodeURIComponent(app.id)}"><bdi>${app.name}</bdi></a></li>`)}</ul>`
    : html`<p>${COPY.empty.noAppsForAccount}</p>
<p class="muted">You can allow an approved AI app to use ${name} from its access settings.</p>`
}
${a.status === "disconnected" && apps.length > 0 ? html`<p class="muted">These AI apps will need your permission again after you reconnect ${name}.</p>` : ""}
<p class="muted small">${COPY.trust.servicesFollowAccount}</p>
<div class="actions">${linkButton("/apps", COPY.actions.manageAiApps)}</div>`;
}

function disconnectSection(a: AccountView, name: Html): Html {
  if (a.status === "disconnected") return html``;
  return html`<h2>Disconnect this account</h2>
<p class="muted">Stop your AI apps from using ${name}. Its Google access will also be removed.</p>
<div class="actions">${linkButton(accountPath(a.id, "disconnect"), COPY.actions.disconnectAccount, "danger")}</div>`;
}

export function renderAccountDetailsPage(p: AccountDetailsPageInput): Promise<string> {
  const a = p.account;
  const name = accountName(a);
  return renderPage({
    title: a.name,
    user: p.user,
    current: "accounts",
    crumbs: [{ href: "/accounts", label: COPY.nav.accounts }, { label: a.name }],
    flash: p.flash,
    body: html`<h1 class="title">${name}</h1>
${accountChips(a)}
${a.alias !== undefined ? html`<p class="mono">${a.email}</p>` : ""}
${a.status === "active" ? "" : attention(a, name)}
<h2>${GLOSSARY.accountName.term}</h2>
${nameForm(p)}
${defaultSection(p, name)}
${servicesSection(a)}
${appsSection(a, name)}
${disconnectSection(a, name)}`,
  });
}

export async function accountDetailsPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const id = boundedId(c.req.param("id"));
  const account = id === undefined ? undefined : ctx.model.account(id);
  if (!account) return notFoundPage(c);
  return sendPage(
    c,
    await renderAccountDetailsPage({ user: ctx.user, model: ctx.model, account, flash: ctx.flash ? accountDetailsFlash(ctx.flash, ctx.model) : null }),
  );
}

/** The details page again with the rejected name in the field and the reason beside it (400). */
async function rejectedName(c: AppContext, session: Session, accountId: string, value: string, message: string): Promise<Response> {
  const model = await loadReadModel(c.env, session.userId);
  const account = model.account(accountId);
  if (!account) return notFoundPage(c);
  const page = await renderAccountDetailsPage({
    user: { email: model.signedInEmail, csrf: session.csrf },
    model,
    account,
    flash: null,
    nameError: { value: value.slice(0, MAX_ECHO), message },
  });
  return sendPage(c, page, 400);
}

/**
 * POST /accounts/:id/name: field `alias`. An empty name clears it (the account shows its email again).
 * Another user's or an unknown account gets the same 404 as its page, and nothing changes.
 */
export async function saveAccountName(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  const id = boundedId(c.req.param("id"));
  const store = openStore(c.env);
  const account = id === undefined ? null : await store.accounts.get(session.userId, id);
  if (!account) return notFoundPage(c);

  const value = field(form, "alias");
  const name = value?.trim();
  if (name === undefined) return rejectedName(c, session, account.id, "", NAME_ERRORS.missing);
  if (name !== "" && !NAME_RULE.test(name.toLowerCase())) return rejectedName(c, session, account.id, value ?? "", NAME_ERRORS.invalid);
  try {
    await store.accounts.setAlias(session.userId, account.id, name === "" ? null : name);
  } catch (e) {
    // The rule above matches the store's, so the store's only remaining refusal is a name already in use.
    if (isGwsError(e) && e.code === "GWS_INVALID_INPUT") return rejectedName(c, session, account.id, value ?? "", NAME_ERRORS.taken);
    throw e;
  }
  await setFlash(c, session.userId, { tone: "success", kind: "account-renamed", accountId: account.id });
  return c.redirect(accountPath(account.id), 303);
}

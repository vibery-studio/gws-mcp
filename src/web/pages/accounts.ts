import { html } from "hono/html";
import type { AppContext } from "../../auth/session";
import { GOOGLE_SERVICES, type GoogleService } from "../../config";
import { COPY, GLOSSARY, SERVICE_NAMES } from "../copy";
import type { Flash } from "../flash";
import { genericFlash, pageContext, sendPage, signedIn } from "../http";
import type { AccountView, ReadModel } from "../read-model";
import { chip, renderPage, statusChip, type FlashMessage, type Html, type ShellUser } from "../ui";

/**
 * GET /accounts: one card per Google account (its name, email, status, default, Google services and the AI
 * apps allowed to use it), and the action that connects another Google account through the existing
 * connect flow. Also the account pages' shared pieces.
 */

export interface AccountsPageInput {
  user: ShellUser;
  model: ReadModel;
  flash: FlashMessage | null;
}

const LEDE = "Manage the Google accounts available to your AI apps. Each account can have different Google services connected.";
const ADD_ANOTHER = "Add another Google account";
const NO_APPS_YET = "No AI apps yet";

/** The path of one of the user's account pages. */
export function accountPath(id: string, page?: "services" | "reconnect" | "disconnect"): string {
  return `/accounts/${encodeURIComponent(id)}${page === undefined ? "" : `/${page}`}`;
}

/**
 * An account's name as shown: its account name (isolated, so its text direction cannot reorder the words
 * around it), or its email in mono when it has none.
 */
export function accountName(a: AccountView): Html {
  return a.alias !== undefined ? html`<bdi>${a.alias}</bdi>` : html`<span class="mono">${a.email}</span>`;
}

/** "Gmail, Drive and Calendar". */
export function serviceList(services: readonly GoogleService[]): string {
  const names = services.map((s) => SERVICE_NAMES[s]);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Google services as read-only chips. */
export function serviceChips(services: readonly GoogleService[], label: string): Html {
  return html`<ul class="chips" aria-label="${label}">${services.map((s) => html`<li>${chip("plain", SERVICE_NAMES[s])}</li>`)}</ul>`;
}

/** The status chip, and the Default chip on the default account. */
export function accountChips(a: AccountView): Html {
  return html`<ul class="chips"><li>${statusChip(a.status)}</li>${a.isDefault ? html`<li>${chip("default", COPY.chips.default)}</li>` : ""}</ul>`;
}

/**
 * Wording of the flashes that land on this page: the connect completion (`account-connected`; a new
 * account also says that no existing AI app can use it yet) and a disconnect.
 */
export function accountsFlash(flash: Flash, model: ReadModel): FlashMessage {
  const account = flash.accountId === undefined ? undefined : model.account(flash.accountId);
  if (flash.kind === "account-connected" && account) {
    return flash.isNew
      ? {
          tone: "success",
          text: `${account.name} is connected. ${COPY.trust.newAccountNotShared(account.name)}`,
          link: { href: "/apps", label: COPY.actions.manageAiApps },
        }
      : { tone: "success", text: `${account.name} is connected.` };
  }
  if (flash.kind === "account-disconnected" && account) return { tone: "success", text: `${account.name} was disconnected.` };
  return genericFlash(flash, model);
}

function accountCard(a: AccountView): Html {
  const apps = a.allowedFor.map((x) => x.name).join(", ");
  return html`<li class="card">
<div class="card-head"><h2 class="card-name"><a href="${accountPath(a.id)}">${accountName(a)}</a></h2>
${accountChips(a)}</div>
${a.alias !== undefined ? html`<p class="mono">${a.email}</p>` : ""}
${a.services.length > 0 ? serviceChips(a.services, GLOSSARY.googleServices.term) : html`<p class="muted">No Google services connected.</p>`}
<p class="muted">Allowed for: <bdi>${apps || NO_APPS_YET}</bdi></p>
<div class="actions">${a.status === "active" ? "" : html`<a class="btn btn-primary" href="${accountPath(a.id, "reconnect")}">${COPY.actions.reconnect}</a>`}<a class="btn btn-ghost" href="${accountPath(a.id)}">${COPY.actions.manageAccount}</a></div>
</li>`;
}

/**
 * Connecting another Google account: the existing connect flow (POST /connections/connect) for every
 * Google service, as a first sign-in does. Google's own screens choose the account and review the access.
 */
function addAccountForm(csrf: string, first: boolean): Html {
  return html`<form method="post" action="/connections/connect" class="card card-wash"><input type="hidden" name="csrf" value="${csrf}">${GOOGLE_SERVICES.map(
    (s) => html`<input type="hidden" name="service" value="${s}">`,
  )}
<p>Google will ask you to choose an account and review access to ${serviceList(GOOGLE_SERVICES)}.</p>
<p class="hint">${COPY.trust.connectedVsAllowed}</p>
<div class="actions"><button type="submit" class="btn btn-primary">${first ? COPY.actions.addGoogleAccount : ADD_ANOTHER}</button></div>
</form>`;
}

export function renderAccountsPage(p: AccountsPageInput): Promise<string> {
  const accounts = p.model.accounts;
  return renderPage({
    title: COPY.nav.accounts,
    user: p.user,
    current: "accounts",
    flash: p.flash,
    body: html`<h1 class="title">${COPY.nav.accounts}</h1>
<p class="lede">${LEDE}</p>
<div class="stack">
${accounts.length > 0 ? html`<ul class="list">${accounts.map(accountCard)}</ul>` : html`<p>${COPY.empty.noAccounts}</p>`}
${addAccountForm(p.user.csrf, accounts.length === 0)}
</div>`,
  });
}

export async function accountsPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  return sendPage(c, await renderAccountsPage({ user: ctx.user, model: ctx.model, flash: ctx.flash ? accountsFlash(ctx.flash, ctx.model) : null }));
}

import { html } from "hono/html";
import type { AppContext } from "../../auth/session";
import { COPY } from "../copy";
import { boundedId, genericFlash, notFoundPage, pageContext, sendPage, signedIn } from "../http";
import type { AccountView, ReadModel } from "../read-model";
import { confirmLayout, linkButton, renderPage, type FlashMessage, type Html, type ShellUser } from "../ui";
import { accountName, accountPath } from "./accounts";

/**
 * GET /accounts/:id/disconnect: the confirmation before disconnecting an account. Its form posts to the
 * existing POST /connections/disconnect (fields `csrf`, `account`), which revokes the account's Google
 * access, wipes it and redirects to /accounts with an `account-disconnected` flash.
 *
 * What disconnecting does not do, worded from the verified backend behaviour: the sign-in account may still
 * sign in, the default account stays the default until the user picks another, the AI apps allowed to use
 * the account keep their rows only until a reconnect clears them, and nothing in Google is deleted.
 */

export interface AccountDisconnectPageInput {
  user: ShellUser;
  model: ReadModel;
  account: AccountView;
  flash: FlashMessage | null;
}

/** Disconnecting never ends sign-in for the account the user signs in with. */
export const STILL_SIGNS_IN = "You can still sign in here with this Google account.";
/** The default does not move on a disconnect, and calls that name no account resolve it and fail. */
export const STAYS_DEFAULT =
  "It stays your default account until you choose another one; until then, AI apps that don't name an account can't use any account.";
/** A reconnect clears the AI apps' rows for the account, so they need a fresh allow. */
export const NEEDS_PERMISSION_AGAIN = "AI apps that could use it will need your permission again after you reconnect it.";

/**
 * The note in the confirmation, just before its buttons: for the sign-in or default account, what still
 * holds after the disconnect (together, exactly the agreed wording); for any account, that reconnecting does
 * not restore the AI apps' access.
 */
export function disconnectNote(a: AccountView): string {
  return [...(a.isPrimary ? [STILL_SIGNS_IN] : []), ...(a.isDefault ? [STAYS_DEFAULT] : []), NEEDS_PERMISSION_AGAIN].join(" ");
}

function alreadyDisconnected(a: AccountView, name: Html): Html {
  return html`<h1 class="title">${name} is disconnected</h1>
<p class="lede">Your AI apps can't use ${name}. ${COPY.trust.googleDataNotDeleted}</p>
<div class="actions">${linkButton(accountPath(a.id, "reconnect"), COPY.actions.reconnect, "primary")}${linkButton(accountPath(a.id), COPY.actions.backToAccount)}</div>`;
}

function confirmation(p: AccountDisconnectPageInput): Html {
  const a = p.account;
  const note = disconnectNote(a);
  const warn = a.isPrimary || a.isDefault;
  return html`${confirmLayout({
    heading: `Disconnect ${a.name}?`,
    stops: [`All your AI apps will stop using ${a.name} through ${COPY.product}.`, "Google access for this account will be removed."],
    stays: [
      ...(p.model.accounts.length > 1 ? ["Your other Google accounts are not affected."] : []),
      COPY.trust.googleDataNotDeleted,
    ],
    // The note leads the actions row, so the warning is read before the button it warns about.
    action: html`<p class="${warn ? "flash flash-warning confirm" : "muted confirm"}">${note}</p><form method="post" action="/connections/disconnect" class="inline"><input type="hidden" name="csrf" value="${p.user.csrf}"><input type="hidden" name="account" value="${a.id}"><button type="submit" class="btn btn-destructive">Disconnect ${a.name}</button></form>`,
    cancelHref: accountPath(a.id),
  })}`;
}

export function renderAccountDisconnectPage(p: AccountDisconnectPageInput): Promise<string> {
  const a = p.account;
  const title = a.status === "disconnected" ? `${a.name} is disconnected` : `Disconnect ${a.name}?`;
  return renderPage({
    title,
    user: p.user,
    current: "accounts",
    crumbs: [{ href: "/accounts", label: COPY.nav.accounts }, { href: accountPath(a.id), label: a.name }, { label: COPY.actions.disconnectAccount }],
    flash: p.flash,
    body: a.status === "disconnected" ? alreadyDisconnected(a, accountName(a)) : confirmation(p),
  });
}

export async function accountDisconnectPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const id = boundedId(c.req.param("id"));
  const account = id === undefined ? undefined : ctx.model.account(id);
  if (!account) return notFoundPage(c);
  return sendPage(c, await renderAccountDisconnectPage({ user: ctx.user, model: ctx.model, account, flash: ctx.flash ? genericFlash(ctx.flash, ctx.model) : null }));
}

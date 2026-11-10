import { html } from "hono/html";
import type { AppContext } from "../../auth/session";
import { COPY, GLOSSARY } from "../copy";
import { boundedId, genericFlash, notFoundPage, pageContext, sendPage, signedIn } from "../http";
import type { AccountView, ReadModel } from "../read-model";
import { linkButton, renderPage, type FlashMessage, type Html, type ShellUser } from "../ui";
import { accountName, accountPath, serviceChips } from "./accounts";

/**
 * GET /accounts/:id/reconnect: why Google needs the user again, and the way back to Google. Reconnect posts
 * to the existing POST /connections/connect (fields `csrf`, `account`, repeated `service`) for the
 * services the account has now, with the account pre-selected at Google. A disconnected account has no
 * services left, so its Reconnect leads to choosing them first.
 */

export interface AccountReconnectPageInput {
  user: ShellUser;
  model: ReadModel;
  account: AccountView;
  flash: FlashMessage | null;
}

function why(a: AccountView, name: Html): Html {
  if (a.status === "reconnect") {
    return html`<p class="lede">${name} needs permission from Google before it can be used again.</p>
<p>${GLOSSARY.needsReconnecting.explain} This is about access, not a sign that something is wrong with your Google account.</p>`;
  }
  if (a.status === "disconnected") {
    return html`<p class="lede">${name} is disconnected. Reconnect it to use it with your AI apps again.</p>`;
  }
  return html`<p class="lede">${name} is connected. You can reconnect it to review its Google access again.</p>`;
}

function reconnectAction(p: AccountReconnectPageInput): Html {
  const a = p.account;
  if (a.services.length === 0) {
    return html`<p>Choose the Google services to connect. Google will ask you to review access to them.</p>
<div class="actions">${linkButton(accountPath(a.id, "services"), COPY.actions.reconnect, "primary")}${linkButton(accountPath(a.id), COPY.actions.cancel)}</div>`;
  }
  const services = a.services.map((s) => html`<input type="hidden" name="service" value="${s}">`);
  return html`<p>Google services to review:</p>
${serviceChips(a.services, GLOSSARY.googleServices.term)}
<form method="post" action="/connections/connect"><input type="hidden" name="csrf" value="${p.user.csrf}"><input type="hidden" name="account" value="${a.id}">${services}
<div class="actions"><button type="submit" class="btn btn-primary">${COPY.actions.reconnect}</button>${linkButton(accountPath(a.id), COPY.actions.cancel)}</div>
</form>`;
}

export function renderAccountReconnectPage(p: AccountReconnectPageInput): Promise<string> {
  const a = p.account;
  const name = accountName(a);
  return renderPage({
    title: `${COPY.actions.reconnect} ${a.name}`,
    user: p.user,
    current: "accounts",
    crumbs: [{ href: "/accounts", label: COPY.nav.accounts }, { href: accountPath(a.id), label: a.name }, { label: COPY.actions.reconnect }],
    flash: p.flash,
    body: html`<h1 class="title">${COPY.actions.reconnect} ${name}</h1>
${why(a, name)}
<p>You'll go to Google to review the access for <span class="mono">${a.email}</span>. When you're done, you'll come back to ${COPY.nav.accounts}.</p>
${a.status === "disconnected" && a.allowedFor.length > 0 ? html`<p class="muted">After you reconnect, AI apps that could use ${name} will need your permission again.</p>` : ""}
${reconnectAction(p)}`,
  });
}

export async function accountReconnectPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const id = boundedId(c.req.param("id"));
  const account = id === undefined ? undefined : ctx.model.account(id);
  if (!account) return notFoundPage(c);
  return sendPage(c, await renderAccountReconnectPage({ user: ctx.user, model: ctx.model, account, flash: ctx.flash ? genericFlash(ctx.flash, ctx.model) : null }));
}

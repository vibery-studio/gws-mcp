import { html } from "hono/html";
import { getSession, type AppContext } from "../../auth/session";
import { GOOGLE_SERVICES, loadConfig } from "../../config";
import { COPY } from "../copy";
import { pageContext, sendPage } from "../http";
import type { AccountView, AppView, ReadModel } from "../read-model";
import { chip, helpBlock, linkButton, renderPage, type FlashMessage, type Html, type ShellUser } from "../ui";
import { accountChips, accountName, accountPath, accountsFlash } from "./accounts";

/**
 * GET /: Home for a signed-in user, the sign-in screen for anyone else.
 *
 * Home is the control overview: accounts that need reconnecting come first, each with its way back to
 * Google, then a summary of the Google accounts and of the AI apps with the way into each area, how to stop
 * an AI app, and the static help on connecting one. It shows only what the read model already holds.
 * First-time setup ends here, so Home words a finished connection the way Google accounts does.
 */

export interface HomePageInput {
  user: ShellUser;
  model: ReadModel;
  flash: FlashMessage | null;
  /** The connector address for the help block (the configured `mcpResource`). */
  connectorUrl: string;
}

export const HOME_COPY = {
  title: "Your AI access",
  lede: "Manage which Google accounts your AI apps can use.",
  attention: (n: number) => (n === 1 ? "One account needs attention" : `${n} accounts need attention`),
  needsReconnect: "needs to reconnect to Google before it can be used again.",
  connectedCount: (n: number) => `${n} connected`,
  approvedCount: (n: number) => `${n} approved`,
  allowed: "Allowed:",
  allowedNone: "Allowed: no Google accounts",
  setUpAccount: "Set up Google account",
  noAppsYet: "No AI apps are connected yet. When you connect an AI app, you'll choose which Google accounts it can use.",
  stopTitle: "Want to stop an AI app?",
  stopBody: "select the app, and remove its access. Your Google accounts stay connected.",
} as const;

export const SIGN_IN_COPY = {
  title: "Manage Google access for your AI apps",
  lede: "Choose which Google accounts your AI apps can use. Review or remove access at any time.",
  firstAccount: "Your first Google account will also be the account you use to sign in here.",
} as const;

/** The accounts Google needs the user to reconnect, each linking to its reconnect page. */
function attentionBanner(accounts: readonly AccountView[]): Html | "" {
  const waiting = accounts.filter((a) => a.status === "reconnect");
  if (waiting.length === 0) return "";
  return html`<section class="flash flash-warning" aria-labelledby="attention-title">
<p id="attention-title"><strong>${HOME_COPY.attention(waiting.length)}</strong></p>
<ul>${waiting.map(
    (a) =>
      html`<li>${accountName(a)} ${HOME_COPY.needsReconnect} <a href="${accountPath(a.id, "reconnect")}">${COPY.actions.reconnect} ${accountName(a)}</a></li>`,
  )}</ul>
</section>`;
}

/** Connecting another Google account: the existing connect flow for every Google service, as on Google accounts. */
function addAccountForm(csrf: string, variant: "primary" | "ghost"): Html {
  return html`<form method="post" action="/connections/connect" class="inline"><input type="hidden" name="csrf" value="${csrf}">${GOOGLE_SERVICES.map(
    (s) => html`<input type="hidden" name="service" value="${s}">`,
  )}<button type="submit" class="btn btn-${variant}">${COPY.actions.addGoogleAccount}</button></form>`;
}

function accountItem(a: AccountView): Html {
  return html`<li><a href="${accountPath(a.id)}">${accountName(a)}</a>${a.alias !== undefined ? html` <span class="mono small muted">${a.email}</span>` : ""}
${accountChips(a)}</li>`;
}

function accountsSummary(p: HomePageInput): Html {
  const accounts = p.model.accounts;
  const connected = accounts.filter((a) => a.status === "active").length;
  const first = accounts.find((a) => a.isPrimary) ?? accounts[0];
  const body =
    first === undefined
      ? html`<p>${COPY.empty.noAccounts}</p>
<div class="actions">${addAccountForm(p.user.csrf, "primary")}</div>`
      : accounts.every((a) => a.services.length === 0)
        ? html`<p>${COPY.empty.firstAccount}</p>
<div class="actions">${linkButton(accountPath(first.id, "services"), HOME_COPY.setUpAccount, "primary")}</div>`
        : html`<ul class="list">${accounts.map(accountItem)}</ul>
<div class="actions">${linkButton("/accounts", COPY.actions.viewAccounts)}${addAccountForm(p.user.csrf, "ghost")}</div>`;
  return html`<section class="card" aria-labelledby="home-accounts">
<div class="card-head"><h2 class="card-name" id="home-accounts">${COPY.nav.accounts}</h2><span class="chips">${chip("plain", HOME_COPY.connectedCount(connected))}</span></div>
${body}
</section>`;
}

/** The accounts an app may use, by name; one that can't be used right now says why. */
function allowedLine(app: AppView, model: ReadModel): Html {
  const allowed = model.allowedAccounts(app.id);
  if (allowed.length === 0) return html`<p class="muted small">${HOME_COPY.allowedNone}</p>`;
  const names = allowed.map((a, i) => html`${i > 0 ? ", " : ""}<bdi>${a.name}</bdi>${a.status === "active" ? "" : ` (${COPY.status[a.status]})`}`);
  return html`<p class="muted small">${HOME_COPY.allowed} ${names}</p>`;
}

function appsSummary(model: ReadModel): Html {
  const apps = model.apps;
  const body =
    apps.length === 0
      ? html`<p>${HOME_COPY.noAppsYet}</p>`
      : html`<ul class="list">${apps.map((app) => html`<li><a href="/apps/${encodeURIComponent(app.id)}"><bdi>${app.name}</bdi></a>${allowedLine(app, model)}</li>`)}</ul>`;
  return html`<section class="card" aria-labelledby="home-apps">
<div class="card-head"><h2 class="card-name" id="home-apps">${COPY.nav.apps}</h2><span class="chips">${chip("plain", HOME_COPY.approvedCount(apps.length))}</span></div>
${body}
<div class="actions">${linkButton("/apps", COPY.actions.manageAiApps)}</div>
</section>`;
}

export function renderHomePage(p: HomePageInput): Promise<string> {
  return renderPage({
    title: COPY.nav.home,
    user: p.user,
    current: "home",
    flash: p.flash,
    body: html`<h1 class="title">${HOME_COPY.title}</h1>
<p class="lede">${HOME_COPY.lede}</p>
${attentionBanner(p.model.accounts)}
<div class="grid">
${accountsSummary(p)}
${appsSummary(p.model)}
</div>
<p class="card card-wash"><strong>${HOME_COPY.stopTitle}</strong> Open <a href="/apps">${COPY.nav.apps}</a>, ${HOME_COPY.stopBody}</p>
${helpBlock(p.connectorUrl)}`,
  });
}

/** Spec screen 1: what the site is for, and the one way in. */
export function renderSignInPage(): Promise<string> {
  return renderPage({
    title: "Sign in",
    body: html`<h1 class="title">${SIGN_IN_COPY.title}</h1>
<p class="lede">${SIGN_IN_COPY.lede}</p>
<p>${SIGN_IN_COPY.firstAccount}</p>
<div class="actions">${linkButton("/login", COPY.actions.continueWithGoogle, "primary")}</div>`,
  });
}

export async function homePage(c: AppContext): Promise<Response> {
  const session = await getSession(c);
  if (!session) return sendPage(c, await renderSignInPage());
  const ctx = await pageContext(c, session);
  const connectorUrl = loadConfig(c.env).mcpResource;
  return sendPage(c, await renderHomePage({ user: ctx.user, model: ctx.model, flash: ctx.flash ? accountsFlash(ctx.flash, ctx.model) : null, connectorUrl }));
}

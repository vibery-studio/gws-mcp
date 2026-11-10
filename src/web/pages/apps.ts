import { html } from "hono/html";
import type { AppContext } from "../../auth/session";
import { loadConfig } from "../../config";
import { COPY } from "../copy";
import type { Flash } from "../flash";
import { genericFlash, pageContext, sendPage, signedIn } from "../http";
import type { AccountView, AppView, ReadModel } from "../read-model";
import { chip, helpBlock, linkButton, renderPage, type ChipTone, type FlashMessage, type Html, type ShellUser } from "../ui";

/** GET /apps: the approved AI apps. */

export interface AppsPageInput {
  user: ShellUser;
  model: ReadModel;
  flash: FlashMessage | null;
  /** The connector address for the help block (the configured `mcpResource`). */
  connectorUrl: string;
}

/** Wording of the flashes that land on this page: an app's removal, a declined request for one more account. */
export function appsFlash(flash: Flash, model: ReadModel): FlashMessage {
  if (flash.kind === "app-removed" && flash.appName !== undefined) return { tone: "success", text: `${flash.appName}'s access was removed.` };
  if (flash.kind === "app-request-declined") {
    const app = flash.appId === undefined ? undefined : model.app(flash.appId);
    return { tone: "success", text: `Nothing changed. ${app?.name ?? "The AI app"} was not allowed another account.` };
  }
  return genericFlash(flash, model);
}

const ACCOUNT_TONE: Readonly<Record<AccountView["status"], ChipTone>> = { active: "plain", reconnect: "warn", disconnected: "off" };

/** An allowed account by name; one that can't be used right now says why. */
function accountChip(a: AccountView): Html {
  return chip(ACCOUNT_TONE[a.status], a.status === "active" ? a.name : `${a.name}: ${COPY.status[a.status]}`);
}

function allowedCount(allowed: number, total: number): string {
  if (allowed === 0) return "Not allowed to use any of your Google accounts.";
  return total === 1 ? "Allowed to use your Google account." : `Allowed to use ${allowed} of your ${total} Google accounts.`;
}

function appItem(app: AppView, model: ReadModel): Html {
  const allowed = model.allowedAccounts(app.id);
  const href = `/apps/${encodeURIComponent(app.id)}`;
  return html`<li class="card">
<div class="card-head"><h2 class="card-name"><a href="${href}"><bdi>${app.name}</bdi></a></h2><span class="chips">${chip("ok", COPY.chips.approved)}</span></div>
<p class="muted">${allowedCount(allowed.length, model.accounts.length)}</p>
${allowed.length > 0 ? html`<p class="chips">${allowed.map(accountChip)}</p>` : ""}
<div class="actions">${linkButton(href, COPY.actions.manageAccess)}</div>
</li>`;
}

export function renderAppsPage(p: AppsPageInput): Promise<string> {
  const apps = p.model.apps;
  return renderPage({
    title: COPY.nav.apps,
    user: p.user,
    current: "apps",
    flash: p.flash,
    body: html`<h1 class="title">${COPY.nav.apps}</h1>
${
  apps.length > 0
    ? html`<p class="lede">These AI apps have been approved to use your connected Google accounts. You can change which accounts they can use or remove their access.</p>
<p class="small muted">AI app names come from the apps themselves. ${COPY.product} can't confirm who made them.</p>
<ul class="list">${apps.map((app) => appItem(app, p.model))}</ul>`
    : html`<p class="lede">${COPY.empty.noApps}</p>
${helpBlock(p.connectorUrl)}`
}`,
  });
}

export async function appsPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const connectorUrl = loadConfig(c.env).mcpResource;
  return sendPage(c, await renderAppsPage({ user: ctx.user, model: ctx.model, flash: ctx.flash ? appsFlash(ctx.flash, ctx.model) : null, connectorUrl }));
}

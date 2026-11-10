import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { CAPABILITIES_TEXT, displayAccountName } from "../auth/consent-page";
import { GOOGLE_SERVICES, type GoogleService } from "../config";
import type { AccountStatus } from "../store/db";
import { COPY, SERVICE_NAMES } from "./copy";
import { chip, renderPage, statusChip } from "./ui";

export interface PageAccount {
  id: string;
  email: string;
  alias?: string;
  isDefault: boolean;
  status: AccountStatus;
  scopes: readonly string[];
  /** Per service: every scope the connect flow asks for it is granted. */
  services: Readonly<Record<GoogleService, boolean>>;
}

export interface PageClient {
  clientId: string;
  /** Already passed through `displayClientName`; still escaped here like every value. */
  name: string;
  redirectHosts: readonly string[];
  /** Epoch seconds of the latest approval. */
  approvedAt: number;
  /** Account ids in the client's allowlist. */
  allowed: readonly string[];
}

export interface ConfirmGrantPageInput {
  csrf: string;
  token: string;
  client: PageClient;
  /** The account the agent suggested (untrusted text, shown without control or format characters); nothing is pre-selected. */
  hint?: string;
  /** The user's active accounts the client may not use yet. */
  choices: readonly PageAccount[];
}

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Control and format characters (bidi overrides and isolates, zero-width): invisible, or they reorder text. */
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;

function serviceList(a: PageAccount): string {
  const names = GOOGLE_SERVICES.filter((s) => a.services[s]).map((s) => SERVICE_NAMES[s]);
  return names.length > 0 ? names.join(", ") : "No Google services connected yet.";
}

/**
 * One account to choose: its email first, then its account name (which an AI app may have set: cleaned and
 * isolated in `<bdi>`), status, default mark and services.
 */
function grantChoice(a: PageAccount): Html {
  const name = displayAccountName(a.alias);
  return html`<label class="check"><input type="radio" name="account" value="${a.id}" required><span class="check-body"><span class="mono">${a.email}</span>${
    name ? html`<span><bdi>${name}</bdi></span>` : ""
  }<span class="chips">${statusChip(a.status)}${a.isDefault ? chip("default", COPY.chips.default) : ""}</span><span class="hint">${serviceList(a)}</span></span></label>`;
}

/**
 * The page where the user confirms (or declines) an AI app's request to use one more account, in the same
 * pattern as the approve page: the request is the whole page, the app is named exactly as approved and never
 * as verified, and nothing is chosen for the user. This human-submitted form is the only way such a request
 * becomes access.
 */
export function renderConfirmGrantPage(p: ConfirmGrantPageInput): Promise<string> {
  const hint = p.hint?.replace(HIDDEN_CHARS, "");
  const name = html`<bdi>${p.client.name}</bdi>`;
  const hosts = p.client.redirectHosts;
  return renderPage({
    title: `Allow ${p.client.name} another account?`,
    body: html`<div class="confirm">
<h1 class="title">Allow ${name} to use another Google account?</h1>
<p class="lede">${name} is asking to use one more of your Google accounts. Choose one, or don't allow it.</p>
${hosts.length > 0 ? html`<p>Access goes to <strong>${hosts.join(", ")}</strong>.</p>` : ""}
<p class="small muted">${COPY.trust.appNameNotVerified} App ID: <span class="mono">${p.client.clientId}</span></p>
${hint ? html`<p>The app asked for: ${hint}</p>` : ""}
<form method="post" action="/connections/confirm-grant"><input type="hidden" name="csrf" value="${p.csrf}"><input type="hidden" name="t" value="${p.token}">
${
  p.choices.length > 0
    ? html`<fieldset><legend>Choose a Google account</legend>${p.choices.map(grantChoice)}</fieldset>
<div class="card card-wash">
<h2>What you're allowing</h2>
<p>${CAPABILITIES_TEXT}</p>
<p>${COPY.trust.writeGuard}</p>
</div>`
    : html`<p>Every connected account is already allowed for ${name}.</p>`
}
<div class="actions">${
      p.choices.length > 0 ? html`<button type="submit" name="decision" value="allow" class="btn btn-primary">Allow selected account</button>` : ""
    }<button type="submit" name="decision" value="deny" class="btn btn-ghost" formnovalidate>${COPY.actions.dontAllow}</button></div>
</form>
</div>`,
  });
}

import { html } from "hono/html";
import type { AccountStatus } from "../store/db";
import { displayClientName } from "./clients";
import { COPY } from "../web/copy";
import { renderPage, statusChip } from "../web/ui";

/** What an approved AI app can do with the accounts chosen for it, in plain words. Shown on every approve page. */
export const CAPABILITIES_TEXT =
  "It can read information and help you work with the Google services connected for the accounts you choose.";

/**
 * An account name as the decision pages show it: cleaned like an AI app's name (no control or bidi
 * characters, which could reorder or hide text), or undefined when nothing visible is left. AI apps can set
 * account names, so the pages always lead with the email and isolate the name in `<bdi>`.
 */
export function displayAccountName(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined;
  const shown = displayClientName(alias, "");
  return shown === "" ? undefined : shown;
}

export interface ConsentAccount {
  id: string;
  email: string;
  alias?: string;
  isDefault: boolean;
  /** Absent means connected: the approve flow offers only connected accounts. */
  status?: AccountStatus;
}

export interface ConsentPageInput {
  /** Self-asserted by the client at registration, already passed through `displayClientName`: always escaped, never trusted. */
  clientName: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  /** What the app asked for. Not shown: an approval always grants the server's own fixed access. */
  scope: readonly string[];
  /**
   * The signed-in user's active accounts. None is pre-checked, so a click-tricked Allow grants an empty
   * allowlist.
   */
  accounts: readonly ConsentAccount[];
  handle: string;
  csrf: string;
}

/**
 * One account choice. The label keeps its plain-text shape (the email, then ` (default)`) because the consent
 * helpers of the tests and the E2E harness read accounts from it. The account name, which an AI app may have
 * set, stays outside the label in `<bdi>`, so it can neither lead the row nor pass for the default marker.
 */
function accountChoice(a: ConsentAccount) {
  const name = displayAccountName(a.alias);
  return html`<div class="check"><label><input type="checkbox" name="account" value="${a.id}"> ${a.email}${a.isDefault ? " (default)" : ""}</label>${
    name ? html` <bdi>${name}</bdi>` : ""
  }${statusChip(a.status ?? "active")}</div>`;
}

/**
 * The approve page: the AI app's request is the whole page (no navigation), it names the app exactly as the
 * backend has it, and nothing is chosen for the user. Every value is escaped by `hono/html`; no script.
 */
export function renderConsentPage(p: ConsentPageInput): Promise<string> {
  const name = html`<bdi>${p.clientName}</bdi>`;
  return renderPage({
    title: `Allow ${p.clientName}?`,
    referrer: "no-referrer",
    body: html`<div class="confirm">
<h1 class="title">Allow ${name} to use your Google accounts?</h1>
<p class="lede">${name} is asking to connect to ${COPY.product}. Choose which of your Google accounts it can use.</p>
<p>Access goes to <strong>${p.redirectHost}</strong>.</p>
<p class="small muted">${COPY.trust.appNameNotVerified}</p>
${
  p.redirectIsLoopback
    ? html`<div class="flash flash-warning" role="note"><p>This AI app runs on your computer. Continue only if you just started connecting it there.</p></div>`
    : ""
}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${p.handle}">
<input type="hidden" name="csrf" value="${p.csrf}">
<fieldset>
<legend>Choose Google accounts</legend>
${p.accounts.length > 0 ? p.accounts.map(accountChoice) : html`<p>${COPY.empty.noAccounts}</p>`}
<p class="hint">Nothing is chosen for you. If you allow without choosing an account: ${COPY.trust.appStaysApprovedWithoutAccounts(p.clientName)}</p>
</fieldset>
<div class="card card-wash">
<h2>What you're allowing</h2>
<p>${CAPABILITIES_TEXT}</p>
<p>${COPY.trust.writeGuard}</p>
<p>You can change which accounts ${name} can use, or remove it, at any time from ${COPY.nav.apps}.</p>
</div>
<div class="actions"><button type="submit" name="decision" value="approve" class="btn btn-primary">${COPY.actions.allowSelected}</button><button type="submit" name="decision" value="deny" class="btn btn-ghost">${COPY.actions.dontAllow}</button></div>
</form>
</div>`,
  });
}

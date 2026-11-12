import { html, raw } from "hono/html";
import type { AppContext, Session } from "../../auth/session";
import { normalizeSettingValue } from "../../core/settings-capability";
import { isGwsError } from "../../errors";
import { openStore } from "../../store/db";
import { openUserSettings } from "../../store/user-settings";
import { COPY, GLOSSARY } from "../copy";
import { setFlash, type Flash } from "../flash";
import { boundedId, field, genericFlash, messagePage, notFoundPage, pageContext, posted, sendPage, signedIn } from "../http";
import { loadReadModel, type AccountView, type ReadModel } from "../read-model";
import { linkButton, postButton, renderPage, type FlashMessage, type Html, type ShellUser } from "../ui";
import { accountChips, accountName, accountPath, serviceChips } from "./accounts";

/**
 * GET /accounts/:id (one account's details: its name, the default, its Google services, its Google Ads details when
 * Google Ads is connected, the AI apps that can use it, and the way to disconnect it), POST /accounts/:id/name (save
 * its account name), POST /accounts/:id/ads (save the Google Ads details) and POST /accounts/:id/ads/remove (remove
 * the saved developer code). Make default posts to the existing POST /connections/set-default; Disconnect leads to
 * the confirmation page.
 */

export interface AccountDetailsPageInput {
  user: ShellUser;
  model: ReadModel;
  account: AccountView;
  flash: FlashMessage | null;
  /** A rejected account name to show again, with the reason beside the field. */
  nameError?: { value: string; message: string };
  /**
   * The user's Google Ads details: the full section when Google Ads is connected for this account, else only whether
   * anything is saved (so it can always be removed). Absent when nothing is saved and Google Ads is not connected.
   */
  ads?: AdsDetails | { connected: false };
  /**
   * Rejected Google Ads details: the reason beside its field, and the manager ID to show again (only digits, spaces and
   * dashes are ever shown back; the developer code never is).
   */
  adsError?: { field: "code" | "manager"; message: string; managerId: string };
}

/**
 * What the full Google Ads section shows: the state of the developer code (never the code) and the manager account ID.
 * "unreadable" is a saved value that no longer decrypts (the server's encryption key changed): save it again or remove it.
 */
export interface AdsDetails {
  connected: true;
  code: "missing" | "saved" | "unreadable";
  /** 10 digits when saved. Not secret: it is the user's own account number. */
  manager: { state: "missing" } | { state: "saved"; id: string } | { state: "unreadable" };
}

/** The store's own account-name rule (64 characters at most, no "@", no control characters), plus no invisible format characters. */
const NAME_RULE = /^[^@\p{Cc}\p{Cf}]{1,64}$/u;
/** The longest rejected value shown back in the field. */
const MAX_ECHO = 256;

/**
 * Wording of the Google Ads section. Google calls the code a "developer token"; the pages say "developer code" and
 * point to where Google Ads shows it.
 */
export const ADS_COPY = {
  title: "Google Ads",
  lede: "Google Ads asks for a developer code before your AI apps can use it. These details are yours: they apply to every Google account you use with Google Ads here.",
  saved: "Your developer code is saved. It is never shown again; you can replace it or remove it.",
  missing: "No developer code is saved yet, so your AI apps can't use Google Ads.",
  unreadable: "Your developer code is saved, but it can't be read any more. Save it again, or remove it.",
  managerUnreadable: "The saved manager account ID can't be read any more. Enter it again, or leave it empty to remove it.",
  codeLabel: "Developer code",
  codeHint: "In Google Ads, open Admin, then API Center, and copy the code shown for developers.",
  keepHint: "Leave it empty to keep the saved code.",
  managerLabel: "Manager account ID (optional)",
  managerHint: "Only if you reach your Google Ads accounts through a manager account: its 10-digit ID, like 123-456-7890. Leave it empty if you don't use one.",
  save: "Save Google Ads details",
  remove: "Remove Google Ads details",
  removeHint: "This removes your developer code and manager account ID. Your AI apps can't use Google Ads until you add a developer code again.",
  savedElsewhere: "Your Google Ads details are saved. Any of your Google accounts with Google Ads uses them.",
} as const;

export const ADS_ERRORS = {
  codeMissing: "Enter your developer code.",
  codeInvalid: "That doesn't look like a developer code. Copy the whole code from the API Center.",
  managerInvalid: "Use the 10-digit ID, like 123-456-7890.",
} as const;

/** Longest developer code the field takes; the store's rule is stricter. */
export const MAX_CODE = 128;
/**
 * A rejected manager ID is shown back only when it looks like one (digits, spaces, dashes). Anything else, such as a
 * developer code pasted into the wrong field, is never put back in the page.
 */
const ECHOABLE_MANAGER_ID = /^[\d\s-]{0,32}$/;

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
  if (flash.kind === "ads-saved") return { tone: "success", text: "Google Ads details saved." };
  if (flash.kind === "ads-removed") return { tone: "success", text: "Google Ads details removed." };
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

/** A stored manager ID as the Ads UI writes it: 123-456-7890. */
function formatManagerId(id: string): string {
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;
}

function removeAdsButton(p: AccountDetailsPageInput): Html {
  return html`<p class="muted small">${ADS_COPY.removeHint}</p>
<div class="actions">${postButton({ csrf: p.user.csrf, action: `${accountPath(p.account.id)}/ads/remove`, label: ADS_COPY.remove, variant: "danger" })}</div>`;
}

/** Saved details seen from an account without Google Ads: only the way to remove them. */
function adsSavedElsewhere(p: AccountDetailsPageInput): Html {
  return html`<h2>${ADS_COPY.title}</h2>
<p>${ADS_COPY.savedElsewhere}</p>
${removeAdsButton(p)}`;
}

function adsSection(p: AccountDetailsPageInput, ads: AdsDetails): Html {
  const err = p.adsError;
  const action = `${accountPath(p.account.id)}/ads`;
  const manager = err !== undefined ? err.managerId : ads.manager.state === "saved" ? formatManagerId(ads.manager.id) : "";
  const codeErr = err?.field === "code" ? err.message : undefined;
  const managerErr = err?.field === "manager" ? err.message : undefined;
  const codeState = { saved: ADS_COPY.saved, missing: ADS_COPY.missing, unreadable: ADS_COPY.unreadable }[ads.code];
  return html`<h2>${ADS_COPY.title}</h2>
<p class="muted">${ADS_COPY.lede}</p>
<p>${codeState}</p>
<form method="post" action="${action}"><input type="hidden" name="csrf" value="${p.user.csrf}">
<div class="field">
<label for="ads-code">${ADS_COPY.codeLabel}</label>
<p class="hint" id="ads-code-hint">${ADS_COPY.codeHint}${ads.code === "saved" ? ` ${ADS_COPY.keepHint}` : ""}</p>
${codeErr !== undefined ? html`<p class="field-error" id="ads-code-error">${codeErr}</p>` : ""}
<input type="password" id="ads-code" name="developerCode" value="" maxlength="${MAX_CODE}" autocomplete="off" spellcheck="false" aria-describedby="ads-code-hint${codeErr !== undefined ? " ads-code-error" : ""}"${codeErr !== undefined ? raw(' aria-invalid="true"') : ""}>
</div>
<div class="field">
<label for="ads-manager">${ADS_COPY.managerLabel}</label>
<p class="hint" id="ads-manager-hint">${ADS_COPY.managerHint}</p>
${ads.manager.state === "unreadable" && err === undefined ? html`<p class="field-error" id="ads-manager-unreadable">${ADS_COPY.managerUnreadable}</p>` : ""}
${managerErr !== undefined ? html`<p class="field-error" id="ads-manager-error">${managerErr}</p>` : ""}
<input type="text" id="ads-manager" name="managerId" value="${manager}" maxlength="32" autocomplete="off" inputmode="numeric" aria-describedby="ads-manager-hint${managerErr !== undefined ? " ads-manager-error" : ""}"${managerErr !== undefined ? raw(' aria-invalid="true"') : ""}>
</div>
<button type="submit" class="btn btn-primary">${ADS_COPY.save}</button>
</form>
${ads.code !== "missing" || ads.manager.state !== "missing" ? removeAdsButton(p) : ""}`;
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
${p.ads === undefined ? "" : p.ads.connected ? adsSection(p, p.ads) : adsSavedElsewhere(p)}
${appsSection(a, name)}
${disconnectSection(a, name)}`,
  });
}

/**
 * The Google Ads details for the page of `account`: the full section when Google Ads is connected for it; else, when
 * anything is saved, only that (nothing is decrypted then); else undefined. A value that no longer decrypts is shown as
 * such, never as an error page.
 */
async function adsDetails(env: Env, userId: string, account: AccountView): Promise<AdsDetails | { connected: false } | undefined> {
  const settings = openUserSettings(env);
  if (!account.services.includes("ads")) {
    const saved = await Promise.all([settings.isSet(userId, "ads.developer_token"), settings.isSet(userId, "ads.login_customer_id")]);
    return saved.some(Boolean) ? { connected: false } : undefined;
  }
  const [code, manager] = await Promise.all([settings.state(userId, "ads.developer_token"), managerState(settings, userId)]);
  return { connected: true, code, manager };
}

async function managerState(settings: ReturnType<typeof openUserSettings>, userId: string): Promise<AdsDetails["manager"]> {
  try {
    const id = await settings.get(userId, "ads.login_customer_id");
    return id === null ? { state: "missing" } : { state: "saved", id };
  } catch (e) {
    if (isGwsError(e) && e.code === "GWS_SETTING_UNREADABLE") return { state: "unreadable" };
    throw e;
  }
}

export async function accountDetailsPage(c: AppContext): Promise<Response> {
  const ctx = await pageContext(c, signedIn(c));
  const id = boundedId(c.req.param("id"));
  const account = id === undefined ? undefined : ctx.model.account(id);
  if (!account) return notFoundPage(c);
  const ads = await adsDetails(c.env, ctx.session.userId, account);
  return sendPage(
    c,
    await renderAccountDetailsPage({
      user: ctx.user,
      model: ctx.model,
      account,
      flash: ctx.flash ? accountDetailsFlash(ctx.flash, ctx.model) : null,
      ...(ads !== undefined ? { ads } : {}),
    }),
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

/** The details page again with the Ads error beside its field (400). The developer code is never put back in the page. */
async function rejectedAds(
  c: AppContext,
  session: Session,
  account: AccountView,
  model: ReadModel,
  error: NonNullable<AccountDetailsPageInput["adsError"]>,
): Promise<Response> {
  const ads = await adsDetails(c.env, session.userId, account);
  const page = await renderAccountDetailsPage({
    user: { email: model.signedInEmail, csrf: session.csrf },
    model,
    account,
    flash: null,
    ...(ads !== undefined ? { ads } : {}),
    adsError: { ...error, managerId: ECHOABLE_MANAGER_ID.test(error.managerId) ? error.managerId : "" },
  });
  return sendPage(c, page, 400);
}

/**
 * POST /accounts/:id/ads: fields `developerCode` (empty keeps the saved one) and `managerId` (empty removes it). The
 * details belong to the user, not the account; the account only places the form, so it must be one of the user's
 * with Google Ads connected (another user's or an unknown account gets the same 404 as its page). Both fields are
 * checked before either is saved; a refused developer code is never shown back.
 */
export async function saveAdsDetails(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  const id = boundedId(c.req.param("id"));
  const model = await loadReadModel(c.env, session.userId);
  const account = id === undefined ? undefined : model.account(id);
  if (!account) return notFoundPage(c);
  if (!account.services.includes("ads")) {
    return messagePage(c, 400, "Google Ads isn't connected", "Add Google Ads to this account from its Google services first.");
  }
  const settings = openUserSettings(c.env);
  const codeInput = (field(form, "developerCode") ?? "").trim();
  const managerInput = (field(form, "managerId") ?? "").trim();

  let code: string | undefined;
  if (codeInput !== "") {
    const normalized = codeInput.length > MAX_CODE ? null : normalizeSettingValue("ads.developer_token", codeInput);
    if (normalized === null) return rejectedAds(c, session, account, model, { field: "code", message: ADS_ERRORS.codeInvalid, managerId: managerInput });
    code = normalized;
  } else if ((await settings.state(session.userId, "ads.developer_token")) !== "saved") {
    // Nothing usable to keep: none is saved, or the saved one can't be read any more.
    return rejectedAds(c, session, account, model, { field: "code", message: ADS_ERRORS.codeMissing, managerId: managerInput });
  }
  let manager: string | null = null;
  if (managerInput !== "") {
    manager = normalizeSettingValue("ads.login_customer_id", managerInput);
    if (manager === null) return rejectedAds(c, session, account, model, { field: "manager", message: ADS_ERRORS.managerInvalid, managerId: managerInput });
  }

  if (code !== undefined) await settings.set(session.userId, "ads.developer_token", code);
  if (manager === null) await settings.clear(session.userId, "ads.login_customer_id");
  else await settings.set(session.userId, "ads.login_customer_id", manager);
  await setFlash(c, session.userId, { tone: "success", kind: "ads-saved", accountId: account.id });
  return c.redirect(accountPath(account.id), 303);
}

/**
 * POST /accounts/:id/ads/remove: deletes the user's saved Google Ads details (developer code and manager ID), readable
 * or not. The account must be one of the user's, else the same 404 as its page. Google Ads need not be connected: every
 * account page offers this while anything is saved, so saved details can always be removed.
 */
export async function removeAdsCode(c: AppContext): Promise<Response> {
  const { session } = posted(c);
  const id = boundedId(c.req.param("id"));
  const account = id === undefined ? null : await openStore(c.env).accounts.get(session.userId, id);
  if (!account) return notFoundPage(c);
  const settings = openUserSettings(c.env);
  await settings.clear(session.userId, "ads.developer_token");
  await settings.clear(session.userId, "ads.login_customer_id");
  await setFlash(c, session.userId, { tone: "success", kind: "ads-removed", accountId: account.id });
  return c.redirect(accountPath(account.id), 303);
}

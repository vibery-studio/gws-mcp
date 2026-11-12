import { html, raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getSession, type AppContext, type Session } from "../../auth/session";
import { isLinkUsed } from "../../core/links";
import { SETTING_LINK_PATH, isStaleSettingLink, peekSettingLink, settingLinkUsedRow, type SettingLinkRecord } from "../../core/setting-links";
import { normalizeSettingValue, type SettingKey } from "../../core/settings-capability";
import { openUserSettings } from "../../store/user-settings";
import { COPY } from "../copy";
import { field, messagePage, pageHeaders, posted, sendPage, toLogin } from "../http";
import { loadReadModel } from "../read-model";
import { renderPage, type ShellUser } from "../ui";
import { ADS_COPY, ADS_ERRORS, MAX_CODE } from "./account-details";

/**
 * GET and POST /settings/set?t=…: the page of a one-time setting link (see src/core/setting-links.ts). An AI app hands
 * the person the link; they enter the value here, so it never passes through the chat.
 *
 * The link alone grants nothing. Without a session the browser signs in first and comes back to the link. Only the
 * user the link was made for may use it: anyone else gets exactly the refusal of a used, expired or unknown link, so
 * they learn nothing about it, and it stays unused. The page shows who is signed in and which setting it sets. The
 * value is posted in the body only (session, Origin and CSRF checked by `guardPost`, as every other form), and saved
 * through the same encrypted store as the account page in one transaction with the link's use and its audit row
 * (`saveFromLink`), so a link saves at most once and a failed save leaves it unused. A link whose user's settings
 * changed since it was made (any save or clear) is refused as out of date.
 *
 * Every response here has the signed-in page headers: `no-store`, so the link's address is never cached, and
 * `Referrer-Policy: same-origin`, so it is never sent to another site, while the form's POST keeps this site's Origin.
 */

/** How the page words each setting. The pages never say "token": Google's developer token is the "developer code". */
const SETTING_COPY: Record<SettingKey, { name: string; label: string; hint: string; type: "password" | "text"; maxlength: number; missing: string; invalid: string }> = {
  "ads.developer_token": {
    name: "Google Ads developer code",
    label: ADS_COPY.codeLabel,
    hint: ADS_COPY.codeHint,
    type: "password",
    maxlength: MAX_CODE,
    missing: ADS_ERRORS.codeMissing,
    invalid: ADS_ERRORS.codeInvalid,
  },
  "ads.login_customer_id": {
    name: "Google Ads manager account ID",
    label: "Manager account ID",
    hint: "The 10-digit ID of the manager account you reach your Google Ads accounts through, like 123-456-7890.",
    type: "text",
    maxlength: 32,
    missing: "Enter the manager account ID.",
    invalid: ADS_ERRORS.managerInvalid,
  },
};

export const SETTING_LINK_COPY = {
  lede: "Your AI app asked you to enter this here, so it never passes through the chat. Your AI app can't see what you enter; it can only check that it's saved.",
  appliesToAll: "It's yours: it applies to every Google account you use with Google Ads here.",
  alreadySaved: "One is already saved. Saving replaces it.",
  once: "This link works once, only for you, and ends 10 minutes after your AI app made it.",
  invalidTitle: "Link not valid",
  invalid:
    "This link expired, was already used, isn't for the account you're signed in with, or isn't valid. Nothing was changed. Ask your AI app for a new one.",
  staleTitle: "Link out of date",
  stale: "This setting changed after the link was made, so nothing was changed. Ask your AI app for a new link.",
  savedTitle: "Saved",
  saved: (name: string) => `Your ${name} is saved. You can close this page and go back to your AI app.`,
} as const;

export interface SettingLinkPageInput {
  user: ShellUser;
  key: SettingKey;
  /** The link token, posted back in a hidden field. */
  token: string;
  /** Whether a value is saved already (never the value). */
  saved: boolean;
  /** Why the entered value was refused; it is never shown back. */
  error?: string;
}

export function renderSettingLinkPage(p: SettingLinkPageInput): Promise<string> {
  const s = SETTING_COPY[p.key];
  const err = p.error;
  return renderPage({
    title: `Set your ${s.name}`,
    user: p.user,
    body: html`<h1 class="title">Set your ${s.name}</h1>
<p class="lede">${SETTING_LINK_COPY.lede}</p>
<p>You're signed in as <span class="mono">${p.user.email}</span>. This sets your ${s.name}. ${SETTING_LINK_COPY.appliesToAll}</p>
${p.saved ? html`<p>${SETTING_LINK_COPY.alreadySaved}</p>` : ""}
<form method="post" action="${SETTING_LINK_PATH}"><input type="hidden" name="csrf" value="${p.user.csrf}"><input type="hidden" name="t" value="${p.token}">
<div class="field">
<label for="setting-value">${s.label}</label>
<p class="hint" id="setting-value-hint">${s.hint}</p>
${err !== undefined ? html`<p class="field-error" id="setting-value-error">${err}</p>` : ""}
<input type="${s.type}" id="setting-value" name="value" value="" maxlength="${s.maxlength}" autocomplete="off" spellcheck="false" aria-describedby="setting-value-hint${err !== undefined ? " setting-value-error" : ""}"${err !== undefined ? raw(' aria-invalid="true"') : ""}>
</div>
<div class="actions"><button type="submit" class="btn btn-primary">Save ${s.name}</button><a class="btn btn-ghost" href="/">${COPY.actions.cancel}</a></div>
</form>
<p class="muted small">${SETTING_LINK_COPY.once}</p>`,
  });
}

/** The one refusal for a link that is malformed, unknown, expired, used, or another user's. */
const notValid = (c: AppContext) => messagePage(c, 400, SETTING_LINK_COPY.invalidTitle, SETTING_LINK_COPY.invalid);

interface UsableLink {
  record: SettingLinkRecord;
  tokenHash: string;
}

/**
 * The link behind `token` for the signed-in `session`, or the refusal to send: not valid (malformed, unknown,
 * expired, used, or another user's: one answer for all, and another user's link stays unused), or, for its own user
 * only, out of date (their settings changed since it was made). Never consumes it.
 */
async function usableLink(c: AppContext, session: Session, token: unknown): Promise<UsableLink | Response> {
  const link = await peekSettingLink(c.env.CACHE_KV, token, Date.now());
  if (!link || link.record.userId !== session.userId) return notValid(c);
  // `used_links` is the authority: KV may still serve a used link's record for a while after it is deleted.
  if (await isLinkUsed(c.env.DB, link.tokenHash)) return notValid(c);
  if (isStaleSettingLink(link.record, await openUserSettings(c.env).version(session.userId))) {
    return messagePage(c, 409, SETTING_LINK_COPY.staleTitle, SETTING_LINK_COPY.stale);
  }
  return link;
}

async function formPage(c: AppContext, session: Session, record: SettingLinkRecord, token: string, status: ContentfulStatusCode, error?: string): Promise<Response> {
  const [model, saved] = await Promise.all([loadReadModel(c.env, session.userId), openUserSettings(c.env).isSet(session.userId, record.key)]);
  const page = await renderSettingLinkPage({
    user: { email: model.signedInEmail, csrf: session.csrf },
    key: record.key,
    token,
    saved,
    ...(error !== undefined ? { error } : {}),
  });
  return sendPage(c, page, status);
}

/** GET /settings/set?t=…: the form, for the user the link was made for. Reading the link does not use it up. */
export async function settingLinkPage(c: AppContext): Promise<Response> {
  const session = await getSession(c);
  if (!session) {
    // Checked before the link is read: signing in first does not use it up, and the browser comes back to it.
    pageHeaders(c);
    return toLogin(c);
  }
  const token = c.req.query("t");
  const link = await usableLink(c, session, token);
  if (link instanceof Response) return link;
  return formPage(c, session, link.record, token ?? "", 200);
}

/**
 * POST /settings/set: fields `t` (the link token) and `value`. The link is checked again, then the value; a refused
 * value shows the form again with the reason, never the value, and keeps the link. A valid value is saved in one
 * transaction with the link's use and the audit row of the person's save (`saveFromLink`): a concurrent or later
 * second use saves nothing and gets the used-link refusal, and a failed save leaves the link unused. Once saved, only
 * the best-effort removal of the link's record follows, so a save is never reported as failed.
 */
export async function saveSettingFromLink(c: AppContext): Promise<Response> {
  const { session, form } = posted(c);
  const token = field(form, "t");
  const link = await usableLink(c, session, token);
  if (link instanceof Response) return link;
  const { record, tokenHash } = link;
  const s = SETTING_COPY[record.key];
  const entered = (field(form, "value") ?? "").trim();
  if (entered === "") return formPage(c, session, record, token ?? "", 400, s.missing);
  const value = entered.length > s.maxlength ? null : normalizeSettingValue(record.key, entered);
  if (value === null) return formPage(c, session, record, token ?? "", 400, s.invalid);

  const now = Date.now();
  const result = await openUserSettings(c.env).saveFromLink(session.userId, record.key, value, {
    tokenHash,
    version: record.version,
    now,
    audit: settingLinkUsedRow(record, now),
  });
  if (result === "used") return notValid(c);
  if (result === "stale") return messagePage(c, 409, SETTING_LINK_COPY.staleTitle, SETTING_LINK_COPY.stale);
  // The record only lets the page show the form; `used_links` already refuses the link everywhere.
  await c.env.CACHE_KV.delete(tokenHash).catch(() => undefined);
  return messagePage(c, 200, SETTING_LINK_COPY.savedTitle, SETTING_LINK_COPY.saved(s.name));
}

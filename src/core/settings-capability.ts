import type { AuthProps, PlanStep, SettingsCapability, StepId, UserLink } from "../contracts";
import { GwsError } from "../errors";

/**
 * Per-user settings (the Google Ads developer token and login customer id): the allowed keys, their value rules, the
 * port the runtimes provide and the `ctx.settings` capability of `settings.*` fns.
 *
 * Values are host-internal. A snippet only learns whether a key is set; it can clear a key (a dry-run guarded write)
 * but never set one: a value pasted into a chat stays in the AI app's history, so values are entered on the account's
 * page or with the local CLI. The Ads header hook is the only reader of a value.
 */

export const SETTING_KEYS = ["ads.developer_token", "ads.login_customer_id"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** The host fn that would set a value. Refused for every snippet input, before anything else is done with it. */
export const SETTINGS_SET_FN = "settings.set";

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && (SETTING_KEYS as readonly string[]).includes(value);
}

/**
 * Google issues developer tokens as one run of letters, digits, "-" and "_" (22 characters today). The bounds leave
 * room for a format change while keeping every stored token at least the length the redactor matches (8).
 */
const DEVELOPER_TOKEN_RE = /^[A-Za-z0-9_-]{10,128}$/;
/** A Google Ads customer id: 10 digits. Written with dashes in the Ads UI (123-456-7890); sent without them. */
const CUSTOMER_ID_RE = /^\d{10}$/;

/**
 * The value to store for `key`, normalized (surrounding spaces dropped; dashes and inner spaces dropped from a customer
 * id), or null when it does not fit the key's rule. Both values become HTTP header values, so only this narrow
 * alphabet is accepted. Never echo a refused value.
 */
export function normalizeSettingValue(key: SettingKey, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (key === "ads.developer_token") return DEVELOPER_TOKEN_RE.test(v) ? v : null;
  const digits = v.replace(/[\s-]/g, "");
  return CUSTOMER_ID_RE.test(digits) ? digits : null;
}

/** Where a person sets `key`, for every message that asks for one. */
export function settingsWhere(key: SettingKey = "ads.developer_token"): string {
  return `in gws-mcp under Google accounts → the account → Google Ads, or, when gws-mcp runs on your computer, with \`gws-mcp settings set ${key}\``;
}

/** Where a person sets the values, for every message that asks for one. */
export const SETTINGS_WHERE = settingsWhere();

/** What each key is called in messages to AI apps and the CLI. Google's own name; the pages say "developer code". */
export const SETTING_LABELS: Record<SettingKey, string> = {
  "ads.developer_token": "Google Ads developer token",
  "ads.login_customer_id": "Google Ads login customer ID",
};

/**
 * A saved value that no longer decrypts (the server's encryption key changed, a restore under another key, a newer key
 * version). Never an internal error: saving the value again replaces the row and fixes it. Names the key, never a value.
 */
export function settingUnreadable(key: SettingKey): GwsError {
  return new GwsError(
    "GWS_SETTING_UNREADABLE",
    `your saved ${SETTING_LABELS[key]} can't be read any more, for example because the server's encryption key changed. Save it again ${settingsWhere(key)}`,
    { details: { setting: key } },
  );
}

/** A one-time setting link as errors and `settings.requestLink` hand it out: the URL and when it expires (ISO time). */
export interface SettingLinkView {
  url: string;
  expiresAt: string;
}

export function settingLinkView(link: UserLink): SettingLinkView {
  return { url: link.url, expiresAt: new Date(link.expiresAt).toISOString() };
}

/** What an error adds to its message when it carries a one-time setting link in `details.setLink`. */
export const SET_LINK_HINT =
  "Or give the person the one-time link in details.setLink: they open it signed in to gws-mcp and enter the value there, never in the chat (it works once, for 10 minutes)";

/**
 * The refusal of `settings.set` from a snippet. Constant text apart from the optional link (made by the host, never
 * from the input): the input is never echoed.
 */
export function settingsSetRefused(link?: UserLink): GwsError {
  const base = `settings can't be set from an AI app, because anything pasted into a chat stays in its history. Set them ${SETTINGS_WHERE}`;
  return new GwsError("GWS_INVALID_INPUT", link === undefined ? base : `${base}. ${SET_LINK_HINT}`, {
    details: link === undefined ? { reason: "set_outside_ai_app" } : { reason: "set_outside_ai_app", setLink: settingLinkView(link) },
  });
}

/** `settings.requestLink` where gws-mcp has no web page to open a link on (the local stdio server). */
export function settingLinkUnsupported(key: SettingKey): GwsError {
  return new GwsError(
    "GWS_UNSUPPORTED_RUNTIME",
    `this gws-mcp runs on your computer and has no web page for a one-time link. Ask the person to run \`gws-mcp settings set ${key}\` in a terminal on this computer; it asks for the value without showing it`,
    { details: { setting: key } },
  );
}

export function invalidSettingKey(): GwsError {
  return new GwsError("GWS_INVALID_INPUT", `key must be one of: ${SETTING_KEYS.join(", ")}`, { details: { fields: ["key"] } });
}

/**
 * The per-user settings as the runtime provides them (D1 remotely, SQLite locally), each value sealed with the token
 * key. Every method is scoped to `userId`.
 */
export interface UserSettingsPort {
  /** Whether the key holds a value. Never decrypts. */
  readonly isSet: (userId: string, key: SettingKey) => Promise<boolean>;
  /**
   * The decrypted value, or null; GWS_SETTING_UNREADABLE when a saved value no longer decrypts. Host-internal: only the Ads header hook reads it. gws-mcp itself never puts a value in
   * a snippet, result, log, audit row, error or plan step; the developer token is also redacted from execute output.
   */
  readonly get: (userId: string, key: SettingKey) => Promise<string | null>;
  /** Deletes the key's value; false when none was stored. */
  readonly clear: (userId: string, key: SettingKey) => Promise<boolean>;
}

export interface SettingsCapabilityDeps {
  port: UserSettingsPort;
  auth: AuthProps;
  apply: boolean;
  /** Mints (or reuses, within the execute) a one-time link that sets `key` on the web page; refuses where there is none. */
  link(key: SettingKey): Promise<UserLink>;
  /** Records a dry-run plan step for the calling fn. */
  plan(step: Omit<PlanStep, "step">): StepId;
  /** Marks the calling fn as having changed state under apply. */
  applied(): void;
}

/** Builds the `ctx.settings` capability for one `settings.*` call, bound to the calling user. */
export function createSettingsCapability(deps: SettingsCapabilityDeps): SettingsCapability {
  const { port, auth, apply } = deps;
  const capability: SettingsCapability = {
    async isSet(key) {
      if (!isSettingKey(key)) throw invalidSettingKey();
      return port.isSet(auth.userId, key);
    },
    async clear(key) {
      if (!isSettingKey(key)) throw invalidSettingKey();
      if (!apply) {
        const note = `clear your saved ${SETTING_LABELS[key]}${key === "ads.developer_token" ? "; Google Ads calls stop working until it is set again" : ""}`;
        return { applied: false, step: deps.plan({ fn: "settings.clear", effect: "write", destructive: false, note }) };
      }
      deps.applied();
      return { applied: true, value: { cleared: await port.clear(auth.userId, key) } };
    },
    async requestLink(key) {
      if (!isSettingKey(key)) throw invalidSettingKey();
      return deps.link(key);
    },
  };
  return Object.freeze(capability);
}

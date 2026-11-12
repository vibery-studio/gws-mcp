import { z } from "zod";
import type { AuditRow, AuthProps, UserLink } from "../contracts";
import { GwsError } from "../errors";
import { RATE_WINDOW_MS } from "./limits";
import { LINK_TTL_MS, isLinkToken, linkKey, newLinkToken } from "./links";
import type { LinkStore, RateCounter } from "./ports";
import { SETTING_KEYS, type SettingKey } from "./settings-capability";

/**
 * One-time setting links: an AI app hands the person a link to a gws-mcp page where they enter a setting (the Google
 * Ads developer token, say) themselves, so the value never passes through the chat.
 *
 * The link alone grants nothing. Its record is stored under a hash of the token and binds the user, the setting key,
 * the client and execute that made it, and the user's settings version when it was made (bumped by every save and
 * clear). The page requires the web session of that same user and refuses a link whose settings changed since
 * (stale). Its save consumes the link in SQL, in the same transaction (`saveFromLink` in src/store/user-settings.ts),
 * so a link is used at most once on every runtime.
 */

/** The `used_links` purpose of a setting link. */
export const SETTING_LINK_PURPOSE = "setting";

/** The page a setting link opens. */
export const SETTING_LINK_PATH = "/settings/set";
/** Most setting links one user may make per rate window (RATE_WINDOW_MS); refused ones count too. */
export const SETTING_LINK_RATE_LIMIT = 5;

/**
 * The web page where a setting link is used. Only a runtime that serves the web app provides it; without it no link
 * is made (`settings.requestLink` gives GWS_UNSUPPORTED_RUNTIME, and errors carry no link).
 */
export interface SettingLinkPort {
  /** The user's settings version: bumped by every save and clear of any of their settings. Never a value. */
  readonly version: (userId: string) => Promise<number>;
}

const LINK_KIND = SETTING_LINK_PURPOSE;

const SettingLinkRecord = z.strictObject({
  kind: z.literal(LINK_KIND),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  executeId: z.string().min(1),
  key: z.enum(SETTING_KEYS),
  version: z.number().int().nonnegative(),
  exp: z.number(),
});
export type SettingLinkRecord = z.output<typeof SettingLinkRecord>;

export interface MintSettingLinkDeps {
  links: LinkStore;
  rate: RateCounter;
  port: SettingLinkPort;
  /** The public origin the link points to (PUBLIC_BASE_URL). */
  baseUrl: string;
  auth: AuthProps;
  executeId: string;
  now: number;
}

/**
 * Makes a setting link for `key`, bound to the calling user, client and execute and to the user's current settings
 * version. Refuses with GWS_RATE_LIMITED past SETTING_LINK_RATE_LIMIT links per user per window.
 */
export async function mintSettingLink(deps: MintSettingLinkDeps, key: SettingKey): Promise<{ link: UserLink; record: SettingLinkRecord }> {
  const { auth, now } = deps;
  const windowStart = now - (now % RATE_WINDOW_MS);
  const count = await deps.rate.hit(`sl:${auth.userId}`, windowStart);
  if (count > SETTING_LINK_RATE_LIMIT) {
    throw new GwsError("GWS_RATE_LIMITED", `at most ${SETTING_LINK_RATE_LIMIT} setting links per minute per user`, {
      details: { scope: "setting-link", limit: SETTING_LINK_RATE_LIMIT, retryAfterS: Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000)) },
    });
  }
  const record: SettingLinkRecord = {
    kind: LINK_KIND,
    userId: auth.userId,
    clientId: auth.clientId,
    executeId: deps.executeId,
    key,
    version: await deps.port.version(auth.userId),
    exp: now + LINK_TTL_MS,
  };
  const token = newLinkToken();
  await deps.links.put(await linkKey(LINK_KIND, token), JSON.stringify(record), { expirationTtl: Math.ceil(LINK_TTL_MS / 1000) });
  return { link: { url: `${deps.baseUrl}${SETTING_LINK_PATH}?t=${token}`, expiresAt: record.exp }, record };
}

/**
 * The record behind a link token and its `linkKey`, without consuming it, or null when the token is malformed,
 * unknown, expired or unreadable. Whose it is, whether it was used (`isLinkUsed`) and whether it is stale is for the
 * caller to check.
 */
export async function peekSettingLink(links: LinkStore, token: unknown, now: number): Promise<{ record: SettingLinkRecord; tokenHash: string } | null> {
  if (!isLinkToken(token)) return null;
  const tokenHash = await linkKey(LINK_KIND, token);
  const raw = await links.get(tokenHash);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = SettingLinkRecord.safeParse(parsed);
  return r.success && r.data.exp > now ? { record: r.data, tokenHash } : null;
}

/** Whether the user's settings changed since the link was made: then the link never applies again. */
export function isStaleSettingLink(record: SettingLinkRecord, currentVersion: number): boolean {
  return record.version !== currentVersion;
}

/** The `client_id` of audit rows written for the signed-in person on a gws-mcp web page (not an AI app). */
export const WEB_ACTOR = "web";

/**
 * The audit row of a link being made, in the execute of the AI app that asked: like every call that changes nothing
 * of the user's (a read, a dry run), `effect: "read"` and `applied: 0`, whether or not the execute ran under apply.
 * Metadata only: never the token, the URL or a value.
 */
export function settingLinkMintedRow(record: SettingLinkRecord, ts: number): AuditRow {
  return row({ execute_id: record.executeId, user_id: record.userId, client_id: record.clientId, fn: `settings.link.minted:${record.key}`, effect: "read", applied: 0, ts });
}

/**
 * The audit row of a link being used: the signed-in person saved the setting on the web page, so the actor is
 * WEB_ACTOR and the row has its own id in place of an execute's. Metadata only: never the token, the URL or a value.
 */
export function settingLinkUsedRow(record: SettingLinkRecord, ts: number): AuditRow {
  return row({ execute_id: `web:${crypto.randomUUID()}`, user_id: record.userId, client_id: WEB_ACTOR, fn: `settings.link.used:${record.key}`, effect: "write", applied: 1, ts });
}

function row(r: Pick<AuditRow, "execute_id" | "user_id" | "client_id" | "fn" | "effect" | "applied" | "ts">): AuditRow {
  return { id: crypto.randomUUID(), account_id: null, status: "ok", code: null, duration_ms: 0, request_id: null, upstream_status: null, ...r };
}

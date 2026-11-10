import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { isRandomToken, randomToken, sha256Hex, type AppContext } from "../auth/session";

/**
 * One-shot messages across a post/redirect/get. The handler that acted stores a small structured record
 * (what happened, to which of the user's accounts or apps) in KV under a hash of a random reference, and
 * the browser carries only that reference in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax, Path=/).
 * The next page that reads it deletes the record and the cookie, so it shows once. Nothing about the user
 * ever goes into a URL, and pages word the message themselves (escaped on render) from the record's kind.
 */

/** Cookie name without its prefix; browsers receive `__Host-gws_flash`. */
export const FLASH_COOKIE = "gws_flash";
/** Long enough to survive one redirect; KV's shortest expiry is 60 s. */
export const FLASH_TTL_SECONDS = 60;
const FLASH_KEY_PREFIX = "flash:";

export const FLASH_TONES = ["success", "warning", "error"] as const;

/** Everything a flash can report. Pages map each kind to their own wording. */
export const FLASH_KINDS = [
  /** A Google account finished connecting (new, reconnected, or with services added). `accountId`, `isNew`. */
  "account-connected",
  /** `accountId` */
  "account-renamed",
  /** `accountId` */
  "default-set",
  /** `accountId` */
  "account-disconnected",
  /** An AI app's allowed accounts changed. `appId` */
  "app-access-saved",
  /** The user declined an AI app's request for one more account. `appId` */
  "app-request-declined",
  /** `appName`: the app is gone, so its name travels in the record. */
  "app-removed",
  /** A failed action. `code`: a backend error code for `plainError`; optional `accountId` or `appId`. */
  "error",
] as const;

export type FlashKind = (typeof FLASH_KINDS)[number];

const Ref = z.string().min(1).max(256);

export const FlashSchema = z
  .object({
    tone: z.enum(FLASH_TONES),
    kind: z.enum(FLASH_KINDS),
    accountId: Ref.optional(),
    appId: Ref.optional(),
    /** An approved app's display name (already passed through `displayClientName`); escaped on render. */
    appName: z.string().min(1).max(256).optional(),
    isNew: z.boolean().optional(),
    code: z
      .string()
      .regex(/^[A-Za-z_]{1,64}$/)
      .optional(),
  })
  .strict();

export type Flash = z.infer<typeof FlashSchema>;

const StoredFlash = z.object({ userId: z.string().min(1).max(300), flash: FlashSchema }).strict();

async function flashKey(reference: string): Promise<string> {
  return `${FLASH_KEY_PREFIX}${await sha256Hex(reference)}`;
}

/**
 * Stores `flash` for `userId` and sets the cookie on the response being built. Call it right before the
 * redirect. An invalid flash is a programming error and throws.
 */
export async function setFlash(c: AppContext, userId: string, flash: Flash): Promise<void> {
  const record = StoredFlash.parse({ userId, flash });
  const reference = randomToken();
  await c.env.CACHE_KV.put(await flashKey(reference), JSON.stringify(record), { expirationTtl: FLASH_TTL_SECONDS });
  setCookie(c, FLASH_COOKIE, reference, { prefix: "host", httpOnly: true, sameSite: "Lax", maxAge: FLASH_TTL_SECONDS });
}

/**
 * The flash waiting for `userId`, or null. Whatever the browser presented is used up: the cookie is cleared
 * and the record deleted, even when it belongs to another user (a sign-out and sign-in in between) or does
 * not parse.
 */
export async function takeFlash(c: AppContext, userId: string): Promise<Flash | null> {
  const reference = getCookie(c, FLASH_COOKIE, "host");
  if (reference === undefined) return null;
  deleteCookie(c, FLASH_COOKIE, { prefix: "host", httpOnly: true, sameSite: "Lax" });
  if (!isRandomToken(reference)) return null;
  const key = await flashKey(reference);
  const raw = await c.env.CACHE_KV.get(key);
  if (raw === null) return null;
  await c.env.CACHE_KV.delete(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = StoredFlash.safeParse(parsed);
  return r.success && r.data.userId === userId ? r.data.flash : null;
}

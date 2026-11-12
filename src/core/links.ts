/**
 * Single-use link tokens shared by every link kind (connect, grant, setting). A link carries a 32-byte random token.
 * Link records are stored under a hash of it, so the records themselves are not usable links. The token can still be
 * stored elsewhere as part of the link's URL: when a signed-out person opens a link, the sign-in return record keeps
 * that URL for the sign-in's 10 minutes, so it can bring them back to it.
 *
 * Consuming a link that allows a change is done in SQL (`used_links`), in the same batch as that change: see
 * `consumeLinkStatements`.
 */

/** Life of every single-use link. */
export const LINK_TTL_MS = 10 * 60_000;

/** A link token: 32 random bytes, base64url without padding. */
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh link token. */
export function newLinkToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isLinkToken(value: unknown): value is string {
  return typeof value === "string" && LINK_TOKEN_RE.test(value);
}

/** Key of a link record of `kind`: a hash of the token, never the token. Also the link's id in `used_links`. */
export async function linkKey(kind: string, token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return `req:${kind}:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---- Consuming in SQL -----------------------------------------------------------------------------------

/** A prepared statement of the database the consuming batch runs on (D1, or the Node host's and local D1 stand-ins). */
export interface LinkSqlStatement<S> {
  bind(...values: unknown[]): S;
}

export interface LinkSqlDatabase<S extends LinkSqlStatement<S>> {
  prepare(query: string): S;
}

/** A condition that every statement of the consuming batch repeats, so the batch changes nothing unless it holds. */
export interface LinkSqlCondition {
  /** A SQL boolean expression, e.g. `(SELECT settings_version FROM users WHERE id = ?) = ?`. */
  sql: string;
  params: readonly unknown[];
}

export interface LinkConsume {
  /** The link's `linkKey`. */
  tokenHash: string;
  /** What the link is for (`setting`, an approval, ...). */
  purpose: string;
  userId: string;
  now: number;
  /** When given, the link is used only if it holds (checked in the same transaction). */
  when?: LinkSqlCondition;
}

/** `used_links` rows older than this are pruned: twice the link lifetime, so a row outlives every use of its link. */
const USED_LINK_KEEP_MS = 2 * LINK_TTL_MS;
const USED_LINK_PRUNE_BATCH = 100;

/**
 * The statements that use a link once, to run first in the same batch (one transaction) as the change the link
 * allows: a bounded prune of old rows, then the insert of the token hash. A second use of the same link hits the
 * primary key, so its whole batch fails and changes nothing; the caller tells that apart with `isLinkUsed`. With a
 * `when` condition the insert happens only while it holds; the caller's own statements repeat the condition, and
 * one of them reports (by its changed rows) whether the batch applied.
 */
export function consumeLinkStatements<S extends LinkSqlStatement<S>>(db: LinkSqlDatabase<S>, c: LinkConsume): S[] {
  const when = c.when ?? { sql: "1", params: [] };
  return [
    db
      .prepare("DELETE FROM used_links WHERE token_hash IN (SELECT token_hash FROM used_links WHERE used_at < ? LIMIT ?)")
      .bind(c.now - USED_LINK_KEEP_MS, USED_LINK_PRUNE_BATCH),
    db
      .prepare(`INSERT INTO used_links (token_hash, purpose, user_id, used_at) SELECT ?, ?, ?, ? WHERE ${when.sql}`)
      .bind(c.tokenHash, c.purpose, c.userId, c.now, ...when.params),
  ];
}

/** Whether the link with this `linkKey` was used already. */
export async function isLinkUsed(db: { prepare(query: string): { bind(...values: unknown[]): { first(): Promise<unknown> } } }, tokenHash: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS used FROM used_links WHERE token_hash = ?").bind(tokenHash).first()) !== null;
}

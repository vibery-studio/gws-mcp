import type { AccessRole, AccessRuleView } from "../contracts";
import {
  MAX_NOTE,
  comparableEmail,
  domainOf,
  isPlainAscii,
  invalidPattern,
  lastAdmin,
  normalizeEmail,
  parsePattern,
  patternKind,
  patternMatches,
  type PatternKind,
} from "../core/access-capability";
import { GwsError } from "../errors";

/**
 * The access allowlist (`access_rules`): who may use this gws-mcp, and who manages that list. A rule is an exact
 * email or a whole `@domain`; an email matches an exact rule equal to it, or a domain rule equal to the part after
 * its last "@". Both sides are compared lower-cased and trimmed, the way sign-in stores emails, and a domain rule
 * never matches a subdomain or a longer name ending the same way. When an email matches several rules, the highest
 * role wins. Every change writes exactly one `access_audit` row in the same transaction (metadata only).
 */

export type { AccessRole, PatternKind };
/**
 * How a change was made, recorded on its audit row. `setup`: by the operator on the server (scripts/setup.ts on
 * Workers, the Node host's `access` command), with the actor `setup`.
 */
export type AccessVia = "web" | "sdk" | "first-sign-in" | "setup";

/** A rule as stored: the view plus who created it. */
export interface AccessRule extends AccessRuleView {
  createdBy: string;
}

/** A removed rule and, for each user it shut out, the provider grant ids that were recorded for their AI apps. */
export interface RemovedRule {
  rule: AccessRule;
  /**
   * The people no rule matches any more. `grantIds` and `clients`: the approvals and AI apps this removal itself
   * deleted in D1 (none when a concurrent removal deleted them first).
   */
  shutOut: Array<{ userId: string; grantIds: string[]; clients: number }>;
}

export interface AccessChange {
  /** The acting user's id. */
  actor: string;
  via: AccessVia;
}

const MAX_PATTERN = 320;

interface RuleRow {
  pattern: string;
  role: AccessRole;
  note: string | null;
  created_by: string;
  created_at: number;
}

function toRule(r: RuleRow): AccessRule {
  const rule: AccessRule = { pattern: r.pattern, kind: patternKind(r.pattern), role: r.role, createdBy: r.created_by, createdAt: r.created_at };
  if (r.note !== null) rule.note = r.note;
  return rule;
}

const RULE_COLUMNS = "pattern, role, note, created_by, created_at";
/**
 * True while another exact-email admin rule (not ?1) exists. Only exact-email admins count: a domain admin rule names no
 * particular person, so it never keeps the last admin. Part of a single statement, so two concurrent removals or
 * demotions of the last two admins cannot both pass.
 */
const ANOTHER_EXACT_ADMIN = "EXISTS (SELECT 1 FROM access_rules WHERE role = 'admin' AND pattern <> ?1 AND substr(pattern, 1, 1) <> '@')";
/** A rule ?1 whose removal or demotion is allowed: not an exact-email admin, or another exact-email admin remains. */
const MAY_LOSE_ADMIN = `(substr(?1, 1, 1) = '@' OR ${ANOTHER_EXACT_ADMIN})`;
/** The audit row of the statement just before it in the same batch, written only when that statement changed a row. */
const AUDIT_IF_CHANGED = `INSERT INTO access_audit (id, ts, actor, via, action, pattern_kind, pattern, role)
  SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`;

export interface AccessDb {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/** A rule's note as stored: at most MAX_NOTE characters, control and format characters blanked, trimmed; null when empty. */
export function cleanNote(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string" || input.length > MAX_NOTE) {
    throw new GwsError("GWS_INVALID_INPUT", `note must be text of at most ${MAX_NOTE} characters`, { details: { fields: ["note"] } });
  }
  // Control and format characters could hide or reorder what an admin reads.
  return input.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() || null;
}

export function openAccessStore(db: AccessDb, now: () => number = Date.now) {
  const audit = (action: "add" | "role" | "remove", rule: { pattern: string; role: AccessRole }, change: AccessChange) =>
    db
      .prepare(AUDIT_IF_CHANGED)
      .bind(crypto.randomUUID(), now(), change.actor, change.via, action, patternKind(rule.pattern), rule.pattern, rule.role);

  async function get(pattern: string): Promise<AccessRule | null> {
    const r = await db.prepare(`SELECT ${RULE_COLUMNS} FROM access_rules WHERE pattern = ?`).bind(pattern).first<RuleRow>();
    return r ? toRule(r) : null;
  }

  async function list(): Promise<AccessRule[]> {
    const { results } = await db
      .prepare(`SELECT ${RULE_COLUMNS} FROM access_rules ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, pattern`)
      .all<RuleRow>();
    return results.map(toRule);
  }

  /** The highest role of the rules matching `email`, or null (also for a value that is not a plain ASCII email). */
  async function roleFor(email: string): Promise<AccessRole | null> {
    const e = comparableEmail(email);
    if (e === null) return null;
    const domain = domainOf(e);
    if (domain === null) return null;
    const r = await db
      .prepare("SELECT role FROM access_rules WHERE pattern IN (?, ?) ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END LIMIT 1")
      .bind(e, `@${domain}`)
      .first<{ role: AccessRole }>();
    return r?.role ?? null;
  }

  /**
   * The role of a gws-mcp user: the rules matching the user's sign-in email (`users.primary_email`, set when the user
   * was created). Null for an unknown user.
   */
  async function roleForUser(userId: string): Promise<AccessRole | null> {
    const u = await db.prepare("SELECT primary_email FROM users WHERE id = ?").bind(userId).first<{ primary_email: string }>();
    return u ? roleFor(u.primary_email) : null;
  }

  /**
   * First-sign-in bootstrap: makes `email` an admin only while the table is empty. One conditional INSERT, so of two
   * concurrent first sign-ins exactly one succeeds; after it the table is never empty again (the last admin cannot
   * be removed). True when this call created the rule.
   */
  async function bootstrap(email: string, actor: string): Promise<boolean> {
    const parsed = parsePattern(email);
    if (!parsed || parsed.kind !== "email") return false;
    const rule = { pattern: parsed.pattern, role: "admin" as const };
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO access_rules (${RULE_COLUMNS}) SELECT ?, 'admin', NULL, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM access_rules)`,
        )
        .bind(rule.pattern, actor, now()),
      audit("add", rule, { actor, via: "first-sign-in" }),
    ]);
    return (inserted?.meta.changes ?? 0) === 1;
  }

  /**
   * Sets the note of an existing rule (null clears it); true when the note changed. A note is not access: it writes
   * no audit row (audit rows never carry notes).
   */
  async function setNote(pattern: string, input: unknown): Promise<boolean> {
    const note = cleanNote(input);
    const r = await db.prepare("UPDATE access_rules SET note = ?2 WHERE pattern = ?1 AND note IS NOT ?2").bind(pattern, note).run();
    return (r.meta.changes ?? 0) === 1;
  }

  /**
   * Adds a rule, or sets the role of an existing one. A same-role add changes nothing and writes no audit row.
   * Demoting the last admin rule is refused (`lastAdmin`). A concurrent change of the same rule is retried once.
   */
  async function add(
    input: { pattern: unknown; role: unknown; note?: unknown },
    change: AccessChange,
  ): Promise<{ outcome: "added" | "role" | "unchanged"; rule: AccessRule }> {
    const parsed = parsePattern(input.pattern);
    if (!parsed) throw invalidPattern();
    if (input.role !== "admin" && input.role !== "user") {
      throw new GwsError("GWS_INVALID_INPUT", 'role must be "admin" or "user"', { details: { fields: ["role"] } });
    }
    const role: AccessRole = input.role;
    const note = cleanNote(input.note);
    const { pattern } = parsed;

    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await get(pattern);
      if (existing === null) {
        const [res] = await db.batch([
          db.prepare(`INSERT INTO access_rules (${RULE_COLUMNS}) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pattern) DO NOTHING`).bind(pattern, role, note, change.actor, now()),
          audit("add", { pattern, role }, change),
        ]);
        if ((res?.meta.changes ?? 0) === 1) return { outcome: "added", rule: await mustGet(pattern) };
        continue;
      }
      if (existing.role === role) return { outcome: "unchanged", rule: existing };
      const [res] = await db.batch([
        db
          .prepare(`UPDATE access_rules SET role = ?2 WHERE pattern = ?1 AND role = ?3 AND (?2 = 'admin' OR ${MAY_LOSE_ADMIN})`)
          .bind(pattern, role, existing.role),
        audit("role", { pattern, role }, change),
      ]);
      if ((res?.meta.changes ?? 0) === 1) return { outcome: "role", rule: await mustGet(pattern) };
      if (role === "user" && (await isLastExactAdmin(pattern))) throw lastAdmin();
    }
    throw new GwsError("GWS_INVALID_INPUT", "this rule changed at the same time; try again", { details: { reason: "conflict" } });
  }

  async function mustGet(pattern: string): Promise<AccessRule> {
    const rule = await get(pattern);
    if (!rule) throw new GwsError("GWS_INTERNAL", "access rule vanished after its write");
    return rule;
  }

  /** Whether `pattern` is an exact-email admin rule and no other exact-email admin rule exists. */
  async function isLastExactAdmin(pattern: string): Promise<boolean> {
    const rule = await get(pattern);
    if (rule?.role !== "admin" || rule.kind !== "email") return false;
    const other = await db
      .prepare("SELECT 1 AS ok FROM access_rules WHERE role = 'admin' AND pattern <> ? AND substr(pattern, 1, 1) <> '@' LIMIT 1")
      .bind(pattern)
      .first<{ ok: number }>();
    return other === null;
  }

  /**
   * Users whose sign-in email `pattern` matches, with the two rule patterns that could still let each in (their exact
   * email and their `@domain`). Depends only on the pattern and the users, never on the other rules, so it cannot be
   * stale against a concurrent removal: whether another rule still matches is decided inside the removal's batch.
   */
  async function candidatesOf(pattern: string): Promise<Array<{ userId: string; email: string; domain: string }>> {
    const { results } = await db.prepare("SELECT id, primary_email FROM users").all<{ id: string; primary_email: string }>();
    const out: Array<{ userId: string; email: string; domain: string }> = [];
    for (const u of results) {
      const email = comparableEmail(u.primary_email);
      const domain = email === null ? null : domainOf(email);
      if (email !== null && domain !== null && patternMatches(pattern, email)) out.push({ userId: u.id, email, domain: `@${domain}` });
    }
    return out;
  }

  /**
   * Removes a rule, and in the same transaction deletes every AI app approval and account allowlist row of each person
   * left with no matching rule, so their tokens are refused for good whatever happens to the provider grants
   * afterwards (re-adding them revives none). "No matching rule" is decided by each delete itself, inside the batch
   * that D1 serializes: of two concurrent removals of rules covering the same person (`u@d` and `@d`), whichever runs
   * second sees both gone and cuts them off. A refused removal leaves the rule in place, so it cuts nobody off.
   * Removing the last exact-email admin is refused (`lastAdmin`). Null when no such rule exists (nothing changed, no
   * audit row). A concurrent change of the same rule is retried once.
   */
  async function remove(input: unknown, change: AccessChange): Promise<RemovedRule | null> {
    if (typeof input !== "string" || !isPlainAscii(input)) throw invalidPattern();
    // A stored pattern that the stricter input check would refuse can still be removed by its exact text.
    const pattern = parsePattern(input)?.pattern ?? normalizeEmail(input);
    if (pattern.length < 2 || pattern.length > MAX_PATTERN) throw invalidPattern();
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await get(pattern);
      if (!existing) return null;
      const candidates = await candidatesOf(pattern);
      const unmatched = "NOT EXISTS (SELECT 1 FROM access_rules WHERE pattern IN (?, ?))";
      const results = await db.batch([
        db.prepare(`DELETE FROM access_rules WHERE pattern = ?1 AND role = ?2 AND (role <> 'admin' OR ${MAY_LOSE_ADMIN})`).bind(pattern, existing.role),
        audit("remove", existing, change),
        ...candidates.flatMap((c) => [
          db.prepare(`DELETE FROM client_grants WHERE user_id = ? AND ${unmatched} RETURNING client_id`).bind(c.userId, c.email, c.domain),
          db.prepare(`DELETE FROM client_approvals WHERE user_id = ? AND ${unmatched} RETURNING client_id, grant_id`).bind(c.userId, c.email, c.domain),
        ]),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        if (existing.role === "admin" && (await isLastExactAdmin(pattern))) throw lastAdmin();
        continue;
      }
      // What this batch actually deleted, per person. A person is reported as shut out when no rule matches them now,
      // also when a concurrent removal deleted their rows first (their provider grants are then revoked by both).
      const shutOut: RemovedRule["shutOut"] = [];
      for (const [i, c] of candidates.entries()) {
        const grants = (results[2 + 2 * i]?.results ?? []) as Array<{ client_id: string }>;
        const approvals = (results[3 + 2 * i]?.results ?? []) as Array<{ client_id: string; grant_id: string }>;
        if ((await roleFor(c.email)) !== null) continue;
        const clients = new Set([...grants.map((r) => r.client_id), ...approvals.map((r) => r.client_id)]);
        shutOut.push({ userId: c.userId, grantIds: approvals.map((r) => r.grant_id), clients: clients.size });
      }
      return { rule: existing, shutOut };
    }
    throw new GwsError("GWS_INVALID_INPUT", "this rule changed at the same time; try again", { details: { reason: "conflict" } });
  }

  return { get, list, roleFor, roleForUser, bootstrap, add, setNote, remove };
}

export type AccessStore = ReturnType<typeof openAccessStore>;

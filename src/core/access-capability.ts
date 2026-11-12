import type { AccessCapability, AccessRole, AccessRuleView, AuthProps, CapabilityWrite, PlanStep, StepId } from "../contracts";
import { GwsError } from "../errors";

/**
 * The access list's rule shape and matching (shared by the store, sign-in and the capability), and the `ctx.access`
 * capability of `access.*` fns.
 *
 * A rule is an exact email or a whole `@domain`. An email matches an exact rule equal to it, or a domain rule equal
 * to the part after its last "@"; both sides are trimmed and lower-cased, the way sign-in stores emails. A domain rule
 * never matches a subdomain or a longer name ending the same way. When several rules match, the highest role wins.
 */

export type PatternKind = "email" | "domain";

const MAX_PATTERN = 320;
/** The most characters of a rule's note. */
export const MAX_NOTE = 200;
/** A DNS name: dot-separated labels of letters, digits and inner hyphens, at least two labels. */
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** An email's local part: printable ASCII without spaces, quotes, parentheses, brackets, backslashes or "@". */
const LOCAL_RE = /^[!#-&*-?^-~]{1,64}$/;

/** An email as sign-in stores it: trimmed and lower-cased. Check `isPlainAscii` first: see there. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether a raw email or pattern (before lower-casing) is printable ASCII apart from surrounding spaces. Anything else
 * is refused before it is compared: Unicode lower-casing folds some characters into ASCII (U+212A KELVIN SIGN becomes
 * "k"), which would let one address match another person's rule.
 */
export function isPlainAscii(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value.trim());
}

/** The email for comparing against rules: plain ASCII, trimmed and lower-cased, or null. */
export function comparableEmail(email: string): string | null {
  return isPlainAscii(email) ? normalizeEmail(email) : null;
}

/** The part after an email's last "@", or null when there is none. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at < 1 || at === email.length - 1 ? null : email.slice(at + 1);
}

export function patternKind(pattern: string): PatternKind {
  return pattern.startsWith("@") ? "domain" : "email";
}

/**
 * A rule pattern from input, normalized (trimmed, lower-cased), or null when it is neither a plain email
 * (`name@example.com`) nor a domain (`@example.com`). Stricter than the table's CHECK.
 */
export function parsePattern(input: unknown): { pattern: string; kind: PatternKind } | null {
  if (typeof input !== "string" || !isPlainAscii(input)) return null;
  const p = normalizeEmail(input);
  if (p.length < 2 || p.length > MAX_PATTERN) return null;
  if (p.startsWith("@")) return DOMAIN_RE.test(p.slice(1)) ? { pattern: p, kind: "domain" } : null;
  const at = p.lastIndexOf("@");
  if (at < 1) return null;
  return LOCAL_RE.test(p.slice(0, at)) && DOMAIN_RE.test(p.slice(at + 1)) ? { pattern: p, kind: "email" } : null;
}

/** Whether the stored rule `pattern` matches `email`. */
export function patternMatches(pattern: string, email: string): boolean {
  const e = comparableEmail(email);
  if (e === null) return false;
  if (patternKind(pattern) === "email") return pattern === e;
  const domain = domainOf(e);
  return domain !== null && pattern === `@${domain}`;
}

/** The highest role among `rules` that match `email`, or null. */
export function roleAmong(rules: readonly { pattern: string; role: AccessRole }[], email: string): AccessRole | null {
  let role: AccessRole | null = null;
  for (const r of rules) {
    if (!patternMatches(r.pattern, email)) continue;
    if (r.role === "admin") return "admin";
    role = "user";
  }
  return role;
}

export function invalidPattern(): GwsError {
  return new GwsError("GWS_INVALID_INPUT", "pattern must be an email (name@example.com) or a domain (@example.com)", {
    details: { fields: ["pattern"] },
  });
}

/** The refusal for a change that would leave no admin rule. */
export function lastAdmin(): GwsError {
  return new GwsError("GWS_INVALID_INPUT", "the last admin cannot be removed or made a user; add another admin first", {
    details: { reason: "last_admin" },
  });
}

export function adminRequired(): GwsError {
  return new GwsError("GWS_ACCESS_ADMIN_REQUIRED", "only an admin of this gws-mcp can see or change who can use it");
}

/**
 * Refuses unless `userId` is an admin now (read fresh through the port). The dispatcher also calls it before planning an
 * `access.*` call whose input waits on an unexecuted write, so a non-admin never gets a planned step.
 */
export async function requireAccessAdmin(port: AccessPort | undefined, userId: string): Promise<AccessPort> {
  if (!port) throw localMode();
  if ((await port.roleOf(userId)) !== "admin") throw adminRequired();
  return port;
}

// ---- Capability -------------------------------------------------------------------------------------

/**
 * The access list as the runtime provides it. Remote: the D1 store, where a removal also ends the shut-out users'
 * AI app access. The local runtime (one user over stdio) enforces no access list and provides no port.
 */
export interface AccessPort {
  /** The user's current role, read fresh (no cache): it authorizes management. */
  readonly roleOf: (userId: string) => Promise<AccessRole | null>;
  readonly list: () => Promise<AccessRuleView[]>;
  readonly add: (
    input: { pattern: string; role: AccessRole; note?: string },
    actor: string,
  ) => Promise<{ outcome: "added" | "role" | "unchanged"; rule: AccessRuleView }>;
  /**
   * Removes a rule. For each user it shuts out, the AI apps' approvals and account allowlists are deleted in D1 in the
   * same transaction (so their tokens are refused for good), then the provider grants are revoked best-effort:
   * `appsFailed` counts the grants (or grant listings) that could not be revoked or read.
   */
  readonly remove: (
    pattern: string,
    actor: string,
  ) => Promise<{ removed: AccessRuleView | null; usersShutOut: number; appsEnded: number; appsFailed: number }>;
}

export interface AccessCapabilityDeps {
  /** Absent in the local runtime. */
  port: AccessPort | undefined;
  auth: AuthProps;
  apply: boolean;
  /** Records a dry-run plan step for the calling fn. */
  plan(step: Omit<PlanStep, "step">): StepId;
  /** Marks the calling fn as having changed state under apply. */
  applied(destructive: boolean): void;
}

/** The plain warning of a removal whose provider cleanup did not finish. */
export function cleanupWarning(failed: number): string {
  return `the rule is removed and its users can no longer sign in, but ${failed} step${failed === 1 ? "" : "s"} of revoking their AI apps' grants did not finish; their tokens are refused because their approvals were deleted`;
}

function localMode(): GwsError {
  return new GwsError("GWS_INVALID_INPUT", "this gws-mcp runs locally for one person, so it has no list of who can use it", {
    details: { reason: "local_mode" },
  });
}

/** Builds the `ctx.access` capability for one `access.*` call. See `AccessCapability` for the rules. */
export function createAccessCapability(deps: AccessCapabilityDeps): AccessCapability {
  const { auth, apply } = deps;

  const admin = () => requireAccessAdmin(deps.port, auth.userId);

  async function write<T>(fn: string, destructive: boolean, note: string, run: () => Promise<T>): Promise<CapabilityWrite<T>> {
    if (!apply) return { applied: false, step: deps.plan({ fn, effect: "write", destructive, note }) };
    deps.applied(destructive);
    return { applied: true, value: await run() };
  }

  const capability: AccessCapability = {
    async list() {
      return (await admin()).list();
    },

    async add(pattern, role, note) {
      const port = await admin();
      const parsed = parsePattern(pattern);
      if (!parsed) throw invalidPattern();
      if (role !== "admin" && role !== "user") {
        throw new GwsError("GWS_INVALID_INPUT", 'role must be "admin" or "user"', { details: { fields: ["role"] } });
      }
      if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE)) {
        throw new GwsError("GWS_INVALID_INPUT", `note must be text of at most ${MAX_NOTE} characters`, { details: { fields: ["note"] } });
      }
      return write("access.add", false, `${parsed.kind} rule ${parsed.pattern} as ${role}`, () =>
        port.add({ pattern: parsed.pattern, role, ...(note !== undefined ? { note } : {}) }, auth.userId),
      );
    },

    async remove(pattern) {
      const port = await admin();
      if (typeof pattern !== "string" || pattern.trim().length < 2 || pattern.length > MAX_PATTERN) throw invalidPattern();
      const p = normalizeEmail(pattern);
      return write("access.remove", true, `remove rule ${p}; users it shuts out lose their AI apps' access`, async () => {
        const r = await port.remove(p, auth.userId);
        const out = { removed: r.removed !== null, usersShutOut: r.usersShutOut, appsEnded: r.appsEnded, appsFailed: r.appsFailed };
        return r.appsFailed > 0 ? { ...out, warning: cleanupWarning(r.appsFailed) } : out;
      });
    },
  };
  return Object.freeze(capability);
}

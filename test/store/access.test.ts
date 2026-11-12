import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parsePattern, patternMatches, roleAmong } from "../../src/core/access-capability";
import { isGwsError } from "../../src/errors";
import { openAccessStore } from "../../src/store/access";
import migration from "../../migrations/0003_access_rules.sql?raw";

const store = openAccessStore(env.DB);
const ADMIN = { actor: "u_admin", via: "web" as const };

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (!isGwsError(e)) throw e;
    return String(e.details?.reason ?? e.code);
  }
  throw new Error("expected a rejection");
}

async function auditRows(): Promise<Array<Record<string, unknown>>> {
  return (await env.DB.prepare("SELECT actor, via, action, pattern_kind, pattern, role FROM access_audit ORDER BY ts, rowid").all()).results;
}

/** Each test starts from an empty list and audit log (the setup's test rules are dropped here and restored by the setup before the next file). */
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM access_rules"), env.DB.prepare("DELETE FROM access_audit")]);
});

describe("rule shape and matching", () => {
  it("accepts a plain email or an @domain, trimmed and lower-cased, and nothing else", () => {
    expect(parsePattern("  Ann@Example.COM ")).toEqual({ pattern: "ann@example.com", kind: "email" });
    expect(parsePattern("@Example.com")).toEqual({ pattern: "@example.com", kind: "domain" });
    for (const bad of ["", "@", "ann@", "@@example.com", "ann", "@localhost", "ann@exa mple.com", "a'b@example.com", 'a"b@example.com', "a\\b@example.com", "ann@-x.com", "@x..com", 7, null]) {
      expect(parsePattern(bad)).toBeNull();
    }
  });

  it("matches an exact email, or a domain only on the part after the last @, never a lookalike or a subdomain", () => {
    expect(patternMatches("ann@fake.test", "ANN@fake.test ")).toBe(true);
    expect(patternMatches("@fake.test", "bob@fake.test")).toBe(true);
    expect(patternMatches("@fake.test", "x@evil-fake.test")).toBe(false);
    expect(patternMatches("@fake.test", "a@sub.fake.test")).toBe(false);
    expect(patternMatches("@fake.test", "a@fake.test.evil")).toBe(false);
    expect(patternMatches("@fake.test", "fake.test@evil.test")).toBe(false);
    expect(patternMatches("ann@fake.test", "xann@fake.test")).toBe(false);
  });

  it("gives the highest role among the matching rules", () => {
    const rules = [
      { pattern: "@x.test", role: "user" as const },
      { pattern: "boss@x.test", role: "admin" as const },
    ];
    expect(roleAmong(rules, "boss@x.test")).toBe("admin");
    expect(roleAmong(rules, "ann@x.test")).toBe("user");
    expect(roleAmong(rules, "ann@y.test")).toBeNull();
  });
});

describe("the table", () => {
  it("refuses a malformed or upper-case pattern and an unknown role at the database too", async () => {
    for (const [pattern, role] of [
      ["Ann@x.test", "user"],
      ["ann@", "user"],
      ["ann", "user"],
      ["@a@x.test", "user"],
      ["ann @x.test", "user"],
      ["ann@x.test", "owner"],
    ]) {
      await expect(
        env.DB.prepare("INSERT INTO access_rules (pattern, role, note, created_by, created_at) VALUES (?, ?, NULL, 't', 0)").bind(pattern, role).run(),
      ).rejects.toThrow(/CHECK/);
    }
  });

  it("seeds every existing user's sign-in email as admin, with one audit row each, and skips a malformed one", async () => {
    const seed = migration.slice(migration.indexOf("INSERT OR IGNORE INTO access_rules"));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES ('u_seed1', 'Owner@Seed.test', 0)"),
      env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES ('u_seed2', 'second@seed.test', 0)"),
      env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES ('u_seed3', 'bad name@seed.test', 0)"),
    ]);
    for (const statement of seed.split(";").map((x) => x.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
    // Users written by earlier files in this worker are seeded too; assert this test's own rows.
    const own = (pattern: unknown) => String(pattern).endsWith("@seed.test");
    expect((await store.list()).filter((r) => own(r.pattern)).map((r) => [r.pattern, r.role, r.createdBy])).toEqual([
      ["owner@seed.test", "admin", "migration"],
      ["second@seed.test", "admin", "migration"],
    ]);
    expect((await auditRows()).filter((r) => own(r.pattern))).toEqual([
      { actor: "migration", via: "migration", action: "add", pattern_kind: "email", pattern: "owner@seed.test", role: "admin" },
      { actor: "migration", via: "migration", action: "add", pattern_kind: "email", pattern: "second@seed.test", role: "admin" },
    ]);
    await env.DB.prepare("DELETE FROM users WHERE id IN ('u_seed1', 'u_seed2', 'u_seed3')").run();
  });
});

describe("roles", () => {
  it("denies an unknown email and allows exact and domain rules", async () => {
    await store.add({ pattern: "boss@corp.test", role: "admin" }, ADMIN);
    await store.add({ pattern: "@corp.test", role: "user" }, ADMIN);
    expect(await store.roleFor("stranger@else.test")).toBeNull();
    expect(await store.roleFor("x@evil-corp.test")).toBeNull();
    expect(await store.roleFor("x@sub.corp.test")).toBeNull();
    expect(await store.roleFor("Boss@Corp.test")).toBe("admin");
    expect(await store.roleFor("ann@corp.test")).toBe("user");
    expect(await store.roleFor("not-an-email")).toBeNull();
  });

  it("reads a user's role from the user's sign-in email; an unknown user has none", async () => {
    await env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES ('u_roles', 'who@roles.test', 0)").run();
    expect(await store.roleForUser("u_roles")).toBeNull();
    await store.add({ pattern: "@roles.test", role: "user" }, ADMIN);
    expect(await store.roleForUser("u_roles")).toBe("user");
    expect(await store.roleForUser("u_nobody")).toBeNull();
  });
});

describe("changes and their audit rows", () => {
  it("writes exactly one metadata row per change and none for a change that changes nothing", async () => {
    await store.add({ pattern: "a@x.test", role: "admin", note: "the owner" }, ADMIN);
    await store.add({ pattern: "@x.test", role: "user" }, { actor: "u_admin", via: "sdk" });
    expect((await store.add({ pattern: "@X.test", role: "user" }, ADMIN)).outcome).toBe("unchanged");
    expect((await store.add({ pattern: "@x.test", role: "admin" }, ADMIN)).outcome).toBe("role");
    expect(await store.remove("@x.test", ADMIN)).toMatchObject({ rule: { pattern: "@x.test", role: "admin" }, shutOut: [] });
    expect(await store.remove("@x.test", ADMIN)).toBeNull();
    expect(await auditRows()).toEqual([
      { actor: "u_admin", via: "web", action: "add", pattern_kind: "email", pattern: "a@x.test", role: "admin" },
      { actor: "u_admin", via: "sdk", action: "add", pattern_kind: "domain", pattern: "@x.test", role: "user" },
      { actor: "u_admin", via: "web", action: "role", pattern_kind: "domain", pattern: "@x.test", role: "admin" },
      { actor: "u_admin", via: "web", action: "remove", pattern_kind: "domain", pattern: "@x.test", role: "admin" },
    ]);
    // The note is the rule's own; the audit table has no column for it.
    const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('access_audit')").all<{ name: string }>()).results.map((c) => c.name);
    expect(columns.sort()).toEqual(["action", "actor", "id", "pattern", "pattern_kind", "role", "ts", "via"]);
  });

  it("refuses bad input before writing anything", async () => {
    expect(await reason(store.add({ pattern: "nope", role: "user" }, ADMIN))).toBe("GWS_INVALID_INPUT");
    expect(await reason(store.add({ pattern: "a@x.test", role: "owner" }, ADMIN))).toBe("GWS_INVALID_INPUT");
    expect(await reason(store.add({ pattern: "a@x.test", role: "user", note: "n".repeat(201) }, ADMIN))).toBe("GWS_INVALID_INPUT");
    expect(await store.list()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("strips hidden characters from a note", async () => {
    const { rule } = await store.add({ pattern: "n@x.test", role: "user", note: "hi‮there\u0000" }, ADMIN);
    expect(rule.note).toBe("hi there");
  });

  it("sets a rule's note on its own: cleaned like an added one, true only when it changed, no audit row", async () => {
    await store.add({ pattern: "m@x.test", role: "admin", note: "old" }, ADMIN);
    const audited = (await auditRows()).length;
    expect(await store.setNote("m@x.test", "new\u0007note")).toBe(true);
    expect((await store.get("m@x.test"))?.note).toBe("new note");
    expect(await store.setNote("m@x.test", "new\u0007note")).toBe(false);
    expect(await store.setNote("m@x.test", "  ")).toBe(true);
    expect((await store.get("m@x.test"))?.note).toBeUndefined();
    expect(await store.setNote("absent@x.test", "x")).toBe(false);
    expect(await reason(store.setNote("m@x.test", "n".repeat(201)))).toBe("GWS_INVALID_INPUT");
    expect((await store.get("m@x.test"))?.role).toBe("admin");
    expect((await auditRows()).length).toBe(audited);
  });
});

describe("the last admin", () => {
  it("can be neither removed nor made a user, and nothing is audited for the refusal", async () => {
    await store.add({ pattern: "only@x.test", role: "admin" }, ADMIN);
    await store.add({ pattern: "@x.test", role: "user" }, ADMIN);
    expect(await reason(store.remove("only@x.test", ADMIN))).toBe("last_admin");
    expect(await reason(store.add({ pattern: "only@x.test", role: "user" }, ADMIN))).toBe("last_admin");
    expect(await store.get("only@x.test")).toMatchObject({ role: "admin" });
    expect((await auditRows()).filter((r) => r.pattern === "only@x.test")).toHaveLength(1);
    // A domain admin rule names no particular person, so it does not keep the last admin.
    await store.add({ pattern: "@x.test", role: "admin" }, ADMIN);
    expect(await reason(store.remove("only@x.test", ADMIN))).toBe("last_admin");
    expect(await reason(store.add({ pattern: "only@x.test", role: "user" }, ADMIN))).toBe("last_admin");
    // With a second exact-email admin, the first can go; a domain admin rule can always go.
    await store.add({ pattern: "two@x.test", role: "admin" }, ADMIN);
    expect(await store.remove("only@x.test", ADMIN)).not.toBeNull();
    expect((await store.add({ pattern: "@x.test", role: "user" }, ADMIN)).outcome).toBe("role");
    expect(await store.remove("@x.test", ADMIN)).not.toBeNull();
    expect(await reason(store.remove("two@x.test", ADMIN))).toBe("last_admin");
  });

  it("survives two concurrent removals of the only two admins: exactly one succeeds", async () => {
    await store.add({ pattern: "one@x.test", role: "admin" }, ADMIN);
    await store.add({ pattern: "two@x.test", role: "admin" }, ADMIN);
    const results = await Promise.allSettled([store.remove("one@x.test", ADMIN), store.remove("two@x.test", ADMIN)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.list()).filter((r) => r.role === "admin")).toHaveLength(1);
  });

  it("survives a concurrent demotion and removal of the only two admins", async () => {
    await store.add({ pattern: "one@x.test", role: "admin" }, ADMIN);
    await store.add({ pattern: "two@x.test", role: "admin" }, ADMIN);
    await Promise.allSettled([store.add({ pattern: "one@x.test", role: "user" }, ADMIN), store.remove("two@x.test", ADMIN)]);
    expect((await store.list()).filter((r) => r.role === "admin")).toHaveLength(1);
  });
});

describe("first sign-in bootstrap", () => {
  it("makes the first email an admin only while the list is empty, then never again", async () => {
    expect(await store.bootstrap("First@Boot.test", "u_first")).toBe(true);
    expect(await store.bootstrap("second@boot.test", "u_second")).toBe(false);
    expect(await store.list()).toMatchObject([{ pattern: "first@boot.test", role: "admin", createdBy: "u_first" }]);
    expect(await auditRows()).toEqual([
      { actor: "u_first", via: "first-sign-in", action: "add", pattern_kind: "email", pattern: "first@boot.test", role: "admin" },
    ]);
  });

  it("lets exactly one of many concurrent first sign-ins become admin", async () => {
    const emails = Array.from({ length: 8 }, (_, i) => `racer${i}@boot.test`);
    const won = await Promise.all(emails.map((e, i) => store.bootstrap(e, `u_racer${i}`)));
    expect(won.filter(Boolean)).toHaveLength(1);
    const rules = await store.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe(emails[won.indexOf(true)]);
    expect(await auditRows()).toHaveLength(1);
  });

  it("never bootstraps a value that is not an email", async () => {
    expect(await store.bootstrap("@boot.test", "u_x")).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});

describe("a removal cuts off the users it shuts out, in the same transaction", () => {
  /** A user with one account, one approved AI app (two recorded grants) and that app allowed the account. */
  async function userWithApp(id: string, email: string): Promise<void> {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, 0)").bind(id, email),
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, email, google_sub, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
      ).bind(`a_${id}`, id, email, `sub-${id}`),
      env.DB.prepare("INSERT INTO client_approvals (user_id, client_id, grant_id, client_name, created_at) VALUES (?, 'c1', ?, 'App', 0)").bind(id, `g1${id}`),
      env.DB.prepare("INSERT INTO client_approvals (user_id, client_id, grant_id, client_name, created_at) VALUES (?, 'c1', ?, 'App', 1)").bind(id, `g2${id}`),
      env.DB.prepare("INSERT INTO client_grants (user_id, client_id, account_id, created_at) VALUES (?, 'c1', ?, 0)").bind(id, `a_${id}`),
    ]);
  }
  const rows = async (id: string) =>
    (await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM client_approvals WHERE user_id = ?1) AS approvals, (SELECT COUNT(*) FROM client_grants WHERE user_id = ?1) AS grants",
    )
      .bind(id)
      .first<{ approvals: number; grants: number }>()) ?? { approvals: -1, grants: -1 };

  it("deletes the approvals and allowlists of exactly the users the rule matched and no other rule matches", async () => {
    await userWithApp("u_so1", "a@shut.test");
    await userWithApp("u_so2", "b@shut.test");
    await userWithApp("u_so3", "c@other.test");
    await store.add({ pattern: "admin@else.test", role: "admin" }, ADMIN);
    await store.add({ pattern: "@shut.test", role: "user" }, ADMIN);
    await store.add({ pattern: "b@shut.test", role: "user" }, ADMIN);
    await store.add({ pattern: "@other.test", role: "user" }, ADMIN);
    const removed = await store.remove("@shut.test", ADMIN);
    expect(removed?.shutOut).toEqual([{ userId: "u_so1", grantIds: ["g1u_so1", "g2u_so1"], clients: 1 }]);
    expect(await rows("u_so1")).toEqual({ approvals: 0, grants: 0 });
    expect(await rows("u_so2")).toEqual({ approvals: 2, grants: 1 });
    expect(await rows("u_so3")).toEqual({ approvals: 2, grants: 1 });
  });

  it("cuts off a person covered by two rules removed concurrently, whichever removal runs second", async () => {
    await userWithApp("u_ov", "u@overlap.test");
    await store.add({ pattern: "admin@else.test", role: "admin" }, ADMIN);
    await store.add({ pattern: "u@overlap.test", role: "user" }, ADMIN);
    await store.add({ pattern: "@overlap.test", role: "user" }, ADMIN);
    const removed = await Promise.all([store.remove("u@overlap.test", ADMIN), store.remove("@overlap.test", ADMIN)]);
    expect(removed.every((r) => r !== null)).toBe(true);
    expect(await rows("u_ov")).toEqual({ approvals: 0, grants: 0 });
    // Both report the person shut out (no rule matches them now); exactly one deleted their rows.
    expect(removed.map((r) => r?.shutOut.map((u) => u.userId))).toEqual([["u_ov"], ["u_ov"]]);
    expect(removed.map((r) => r?.shutOut[0]?.grantIds.length ?? 0).sort()).toEqual([0, 2]);
  });

  it("cuts nothing when the removal is refused", async () => {
    await userWithApp("u_last", "last@solo.test");
    await store.add({ pattern: "last@solo.test", role: "admin" }, ADMIN);
    expect(await reason(store.remove("last@solo.test", ADMIN))).toBe("last_admin");
    expect(await rows("u_last")).toEqual({ approvals: 2, grants: 1 });
  });
});

describe("non-ASCII emails", () => {
  const KELVIN = "\u212Aaren@x.test";

  it("never match, are never a rule, and never bootstrap, even when lower-casing would fold them into ASCII", async () => {
    expect(KELVIN.toLowerCase()).toBe("karen@x.test");
    await store.add({ pattern: "karen@x.test", role: "admin" }, ADMIN);
    await store.add({ pattern: "@x.test", role: "user" }, ADMIN);
    expect(patternMatches("karen@x.test", KELVIN)).toBe(false);
    expect(patternMatches("@x.test", KELVIN)).toBe(false);
    expect(await store.roleFor(KELVIN)).toBeNull();
    expect(parsePattern(KELVIN)).toBeNull();
    expect(parsePattern("@\u212A.test")).toBeNull();
    expect(await reason(store.add({ pattern: "\u212Aim@y.test", role: "user" }, ADMIN))).toBe("GWS_INVALID_INPUT");
    expect(await reason(store.remove(KELVIN, ADMIN))).toBe("GWS_INVALID_INPUT");
    expect(await store.get("karen@x.test")).not.toBeNull();
  });

  it("never bootstrap an empty list", async () => {
    expect(await store.bootstrap(KELVIN, "u_k")).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});

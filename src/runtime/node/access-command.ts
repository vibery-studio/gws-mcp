import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { addRule, removeRuleAndRevoke } from "../../auth/access";
import { oauthHelpers } from "../../auth/oauth-server";
import { invalidPattern, parsePattern } from "../../core/access-capability";
import { isGwsError } from "../../errors";
import { cleanNote, openAccessStore, type AccessChange, type AccessRole } from "../../store/access";
import { loadNodeHostConfig, NodeHostConfigError, scrubSecretsFromEnv } from "./config";
import { EXIT, isBusy, type CommandIo } from "./command-common";
import { nodeD1 } from "./d1";
import { DatabaseVersionError, openCurrentDatabase, openDatabase } from "./database";
import { nodeKv } from "./kv";

/**
 * The Node host's access-list command (`node server.js access ...`): the operator's way to seed and manage who may
 * use this gws-mcp, as scripts/setup.ts seeds the owner on Workers. It reads the server's configuration (no secret:
 * it uses none) and works on the same database file, before the first boot or while the server runs.
 *
 * - Schema: only a new file is created and migrated (seeding before the first boot). An existing file is used only
 *   when it records exactly this build's migrations; otherwise the command refuses (78), because only the server
 *   migrates an existing database, at boot.
 * - Changes go through the same code as the access page and `sdk.access.*` (src/auth/access.ts over the access
 *   store): the same pattern, role and note checks, the last-admin rule, and one `access_audit` row per access
 *   change, recorded with actor and via `setup`. A removal deletes the shut-out people's AI app approvals in the same
 *   transaction, so the running server refuses their tokens on the next request, then revokes their OAuth grants.
 * - `add` on an existing rule changes its role only when `--admin` or `--no-admin` is given, and its note only when
 *   `--note` is given.
 */

export const ACCESS_USAGE = `usage:
  access list
  access add <email | @domain> [--admin | --no-admin] [--note <text>]
      a new rule is a user unless --admin; on an existing rule only the role or note given changes
  access remove <email | @domain>
      remove a rule and end the access it gave`;

/** The recorded author of a change made with this command. */
const CHANGE: AccessChange = { actor: "setup", via: "setup" };

type Parsed =
  | { action: "list" }
  | { action: "add"; pattern: string; role?: AccessRole; note?: string }
  | { action: "remove"; pattern: string };

function parse(args: readonly string[]): Parsed | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { admin: { type: "boolean" }, "no-admin": { type: "boolean" }, note: { type: "string" } },
    });
  } catch {
    return null;
  }
  const { positionals, values } = parsed;
  const [action, pattern, ...extra] = positionals;
  const flagged = values.admin !== undefined || values["no-admin"] !== undefined || values.note !== undefined;
  if (extra.length > 0) return null;
  if (action === "list" && pattern === undefined && !flagged) return { action };
  if (action === "remove" && pattern !== undefined && !flagged) return { action, pattern };
  if (action === "add" && pattern !== undefined && !(values.admin && values["no-admin"])) {
    const role: AccessRole | undefined = values.admin ? "admin" : values["no-admin"] ? "user" : undefined;
    return { action, pattern, ...(role === undefined ? {} : { role }), ...(values.note === undefined ? {} : { note: values.note }) };
  }
  return null;
}

/** Only this build creates and migrates a new file; an existing one must already have exactly its migrations. */
function open(file: string): DatabaseSync {
  const isNew = !existsSync(file) || (statSync(file).size === 0 && !existsSync(`${file}-wal`));
  return isNew ? openDatabase(file).db : openCurrentDatabase(file);
}

async function run(command: Parsed, db: DatabaseSync, publicEnv: Record<string, unknown>, io: CommandIo): Promise<number> {
  const env: Record<string, unknown> = { ...publicEnv, DB: nodeD1(db), OAUTH_KV: nodeKv(db, "OAUTH_KV"), CACHE_KV: nodeKv(db, "CACHE_KV") };
  env.OAUTH_PROVIDER = oauthHelpers(env as unknown as Env);
  const workerEnv = env as unknown as Env;
  const store = openAccessStore(workerEnv.DB);

  switch (command.action) {
    case "list": {
      const rules = await store.list();
      if (rules.length === 0) io.out("the access list is empty: the first person to sign in becomes its admin (add the owner first: access add <email> --admin)");
      for (const r of rules) io.out([r.role.padEnd(5), r.pattern, ...(r.note === undefined ? [] : [`(${r.note})`])].join(" "));
      return EXIT.ok;
    }
    case "add": {
      const pattern = parsePattern(command.pattern)?.pattern;
      if (pattern === undefined) throw invalidPattern();
      if (command.note !== undefined) cleanNote(command.note);
      const existing = await store.get(pattern);
      if (existing === null) {
        const input = { pattern, role: command.role ?? "user", ...(command.note === undefined ? {} : { note: command.note }) };
        const { outcome, rule } = await addRule(workerEnv, input, CHANGE);
        if (outcome === "added") {
          io.out(`added ${rule.pattern} as ${rule.role}`);
          return EXIT.ok;
        }
      }
      // An existing rule (or one added at the same moment by someone else): only what was given changes.
      const before = existing ?? (await store.get(pattern));
      const changed: string[] = [];
      if (command.role !== undefined && before?.role !== command.role) {
        const { rule } = await addRule(workerEnv, { pattern, role: command.role }, CHANGE);
        changed.push(`role ${before?.role ?? "none"} -> ${rule.role}`);
      }
      if (command.note !== undefined && (await store.setNote(pattern, command.note))) changed.push("note updated");
      const now = await store.get(pattern);
      io.out(changed.length > 0 ? `${pattern}: ${changed.join("; ")}` : `${pattern} is already ${now?.role ?? "absent"}; nothing changed`);
      return EXIT.ok;
    }
    case "remove": {
      const result = await removeRuleAndRevoke(workerEnv, command.pattern, CHANGE);
      if (result.removed === null) {
        io.err("no such rule in the access list; nothing changed");
        return EXIT.refused;
      }
      io.out(`removed ${result.removed.pattern}; people who lost access: ${result.usersShutOut}; AI apps cut off: ${result.appsEnded}`);
      if (result.appsFailed > 0) {
        io.err(`warning: ${result.appsFailed} AI app grant(s) could not be revoked or listed; their tokens are refused anyway, because their approvals are gone`);
      }
      return EXIT.ok;
    }
  }
}

/**
 * Runs `access <args>` and returns the exit code: 0 done, 1 refused (by the access rules), 64 usage, 70 internal
 * failure, 75 database busy (try again), 78 configuration or database version. Prints rules and outcomes, never a
 * secret, never a stack.
 */
export async function runAccessCommand(args: readonly string[], environment: Record<string, string | undefined>, io: CommandIo): Promise<number> {
  const command = parse(args);
  if (command === null) {
    io.err(ACCESS_USAGE);
    return EXIT.usage;
  }
  let db: DatabaseSync | undefined;
  try {
    const config = await loadNodeHostConfig(environment, { secrets: false });
    scrubSecretsFromEnv(environment);
    db = open(config.dbFile);
    return await run(command, db, { ...config.vars, PUBLIC_BASE_URL: config.worker.PUBLIC_BASE_URL }, io);
  } catch (e) {
    if (e instanceof NodeHostConfigError) {
      io.err(`configuration error: ${e.message}`);
      return EXIT.config;
    }
    if (e instanceof DatabaseVersionError) {
      io.err(`refused: ${e.message}`);
      return EXIT.config;
    }
    if (isGwsError(e)) {
      io.err(`refused: ${e.message}`);
      return EXIT.refused;
    }
    if (isBusy(e)) {
      io.err("the database is busy (another process is writing to it); nothing changed; try again");
      return EXIT.tempfail;
    }
    io.err(`failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 300)}`);
    return EXIT.software;
  } finally {
    db?.close();
  }
}

// Wipes the deployed gws-mcp data: every row of the D1 database `gws-mcp` and every key of the KV namespaces
// bound as OAUTH_KV and CACHE_KV. Required before switching GOOGLE_UPSTREAM from fake to google, because
// anyone could mint fake-mode users, MCP grants and sessions.
//
// Default is a dry run that prints the SQL and the namespaces and touches nothing. `--apply` runs it, only
// after confirming that the database is `gws-mcp` and both namespace titles start with `gws-mcp`. Every
// wrangler call passes `--config` with the wrangler.jsonc the ids were read from (it pins the Cloudflare
// account), and the KV commands target the checked namespace ids, never a binding that another config could
// resolve. KV key names (which include session ids) are never printed or put in argv: they pass through a
// mode-600 temp file that is deleted afterwards.
//
// Usage: npx tsx scripts/reset-data.ts [--apply]
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCE_PREFIX = "gws-mcp";
const KV_BINDINGS = ["OAUTH_KV", "CACHE_KV"] as const;
type KvBinding = (typeof KV_BINDINGS)[number];

/** Children before parents, so foreign keys hold at every step. Every table is named, cascade or not. */
export const RESET_SQL = [
  "DELETE FROM client_grants;",
  "DELETE FROM client_approvals;",
  "DELETE FROM audit_log;",
  "DELETE FROM rate_counters;",
  "DELETE FROM accounts;",
  "DELETE FROM users;",
].join(" ");

export interface ResetConfig {
  databaseName: string;
  kv: Record<KvBinding, string>;
  /** The wrangler config these values were read from, passed to every wrangler command. */
  configPath: string;
}

/** Runs `npx wrangler <args>` in the repository root. */
export type ExecLike = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: ExecLike = (args) =>
  new Promise((resolve) => {
    execFile(
      "npx",
      ["wrangler", ...args],
      { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** Reads the D1 name and KV ids from wrangler.jsonc (full-line `//` comments only, as that file uses). */
export function readResetConfig(file = path.join(ROOT, "wrangler.jsonc")): ResetConfig {
  const text = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const cfg = JSON.parse(text) as {
    d1_databases?: Array<{ binding: string; database_name: string }>;
    kv_namespaces?: Array<{ binding: string; id: string }>;
  };
  const db = cfg.d1_databases?.find((d) => d.binding === "DB");
  const kvId = (binding: KvBinding) => {
    const id = cfg.kv_namespaces?.find((k) => k.binding === binding)?.id;
    if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new Error(`wrangler.jsonc has no deployed id for ${binding}`);
    return id;
  };
  if (!db) throw new Error("wrangler.jsonc has no DB binding");
  return { databaseName: db.database_name, kv: { OAUTH_KV: kvId("OAUTH_KV"), CACHE_KV: kvId("CACHE_KV") }, configPath: path.resolve(file) };
}

function parseJsonArray<T>(stdout: string): T[] {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("wrangler printed no JSON array");
  return JSON.parse(stdout.slice(start)) as T[];
}

export async function resetData(opts: {
  apply: boolean;
  config: ResetConfig;
  exec?: ExecLike;
  log?: (line: string) => void;
}): Promise<{ exitCode: number }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const { config } = opts;
  const run = opts.exec ?? defaultExec;
  const exec: ExecLike = (args) => run([...args, "--config", config.configPath]);

  log(`d1 ${config.databaseName} (remote): ${RESET_SQL}`);
  for (const b of KV_BINDINGS) log(`kv ${b} ${config.kv[b]} (remote): delete every key`);
  if (!opts.apply) {
    log("dry run: nothing was changed; pass --apply to run it");
    return { exitCode: 0 };
  }
  if (config.databaseName !== RESOURCE_PREFIX) {
    log(`refused: database "${config.databaseName}" is not ${RESOURCE_PREFIX}`);
    return { exitCode: 1 };
  }

  const listed = await exec(["kv", "namespace", "list"]);
  if (listed.code !== 0) {
    log("refused: could not list KV namespaces");
    return { exitCode: 1 };
  }
  const titles = new Map(parseJsonArray<{ id: string; title: string }>(listed.stdout).map((n) => [n.id, n.title]));
  for (const b of KV_BINDINGS) {
    const title = titles.get(config.kv[b]);
    if (!title?.startsWith(RESOURCE_PREFIX)) {
      log(`refused: ${b} ${config.kv[b]} is not a ${RESOURCE_PREFIX}* namespace on this account`);
      return { exitCode: 1 };
    }
  }

  const d1 = await exec(["d1", "execute", config.databaseName, "--remote", "--command", RESET_SQL]);
  if (d1.code !== 0) {
    log(`d1 ${config.databaseName}: FAILED (exit ${d1.code})`);
    return { exitCode: 1 };
  }
  log(`d1 ${config.databaseName}: rows deleted`);

  for (const b of KV_BINDINGS) {
    const keys = await exec(["kv", "key", "list", "--namespace-id", config.kv[b], "--remote"]);
    if (keys.code !== 0) {
      log(`kv ${b}: FAILED to list keys (exit ${keys.code})`);
      return { exitCode: 1 };
    }
    const names = parseJsonArray<{ name: string }>(keys.stdout).map((k) => k.name);
    if (names.length === 0) {
      log(`kv ${b}: already empty`);
      continue;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "gws-mcp-reset-"));
    try {
      const file = path.join(dir, "keys.json");
      writeFileSync(file, JSON.stringify(names), { mode: 0o600 });
      const del = await exec(["kv", "bulk", "delete", file, "--namespace-id", config.kv[b], "--remote", "--force"]);
      if (del.code !== 0) {
        log(`kv ${b}: FAILED to delete keys (exit ${del.code})`);
        return { exitCode: 1 };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    log(`kv ${b}: deleted ${names.length} keys`);
  }
  return { exitCode: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resetData({ apply: process.argv.includes("--apply"), config: readResetConfig() })
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((e: unknown) => {
      console.error(`reset-data: ${e instanceof Error ? e.message : "failed"}`);
      process.exitCode = 1;
    });
}

// D1 access for the harness through `wrangler d1 execute` on the fake-mode E2E Worker's database (`gws-mcp-e2e`,
// declared by the E2E config that scripts/wrangler.ts picks): the local state of `npm run dev:e2e`, or the deployed
// database (which needs the operator's local wrangler.e2e.jsonc). Never the
// production database `gws-mcp`, which holds real accounts. Then the data-at-rest scan: every table listed in sqlite_master is read whole and searched for the
// run's body/content markers, for secret shapes and for the run's own secret values. Nothing found is ever
// printed, only where it was found.
//
// Standalone: npx tsx scripts/e2e/d1-scan.ts --local|--remote [--marker <text>]...
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { wranglerArgv } from "../wrangler";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The E2E Worker's database, declared in the E2E config. */
export const E2E_DATABASE = "gws-mcp-e2e";
const run = promisify(execFile);

export type D1Mode = "local" | "remote";

/** Values the harness puts into SQL text: ids, emails and markers only. Anything else is refused. */
const SAFE_LITERAL = /^[A-Za-z0-9_.@:+-]{1,200}$/;

export function sqlLiteral(value: string): string {
  if (!SAFE_LITERAL.test(value)) throw new Error("refusing an unsafe SQL literal");
  return `'${value}'`;
}

/**
 * The `npx` argv of one `wrangler d1 execute` on the E2E database, with the E2E config (scripts/wrangler.ts): the
 * local one when present, the example only for `--local`. Throws, running nothing, when remote has no local config.
 */
export function d1ExecuteArgs(mode: D1Mode, sql: string, root = ROOT, exists?: (file: string) => boolean): string[] {
  const res = wranglerArgv("e2e", ["d1", "execute", E2E_DATABASE, `--${mode}`, "--json", "--command", sql], root, exists);
  if (!res.ok) throw new Error(res.message);
  return ["wrangler", ...res.argv];
}

/** Runs one SQL statement and returns its rows. */
export async function d1Query<T = Record<string, unknown>>(mode: D1Mode, sql: string): Promise<T[]> {
  const { stdout } = await run("npx", d1ExecuteArgs(mode, sql), {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });
  const parsed = JSON.parse(stdout) as Array<{ results?: T[]; success?: boolean }>;
  const first = parsed[0];
  if (!first?.success) throw new Error("d1 query failed");
  return first.results ?? [];
}

/** What the scan looks for: exact text, or a shape. */
export interface Needle {
  name: string;
  needle: string | RegExp;
}

/** Secret shapes that may never be at rest in D1 in plaintext. */
export const TOKEN_SHAPES: readonly Needle[] = [
  { name: "access-token prefix ya29.", needle: "ya29." },
  { name: "refresh-token prefix 1//", needle: "1//" },
  { name: "Bearer header", needle: "Bearer " },
  { name: "OAuth client-secret prefix GOCSPX-", needle: "GOCSPX-" },
  { name: "PEM header", needle: "-----BEGIN " },
  // Header and payload are base64url JSON objects ("eyJ"). Anchored after a non-word character, so a long
  // run of "eyJ" is scanned in linear time.
  { name: "JWT shape", needle: /(?<![\w-])eyJ[\w-]+\.eyJ[\w-]+\./ },
];

/** Run secrets shorter than this are not matched: they would match ordinary text. */
const MIN_SECRET_CHARS = 8;

/**
 * Names of the needles found in `text`, and "a run secret value" when any of `secrets` occurs in it exactly.
 * Never returns the matched text.
 */
export function findNeedles(text: string, needles: readonly Needle[], secrets: readonly string[] = []): string[] {
  const hits = needles.filter(({ needle }) => (typeof needle === "string" ? text.includes(needle) : needle.test(text))).map((n) => n.name);
  if (secrets.some((s) => s.length >= MIN_SECRET_CHARS && text.includes(s))) hits.push("a run secret value");
  return hits;
}

/** Cloudflare's internal tables (not readable); matched as an exact prefix, not as a LIKE pattern. */
const INTERNAL_TABLE_PREFIX = "_cf_";

/** Strict standard base64 with canonical padding (the store's ciphertext encoding). */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Random base64 can contain "1//" by chance, so well-formed ciphertext columns are left out of the text
 * search; they are checked by decoding instead. A plaintext token is not strict base64 ("." "-" "_") and
 * stays in the search.
 */
function maskCiphertext(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const col of ["refresh_ct", "refresh_iv"]) {
    const v = out[col];
    if (typeof v === "string" && BASE64.test(v)) out[col] = "<base64 ciphertext>";
  }
  return out;
}

export interface ScanResult {
  tables: Array<{ name: string; rows: number }>;
  /** `<table>: <what>`, never the matched text. */
  hits: string[];
  /** Base64 refresh ciphertexts sampled from `accounts`. */
  refreshCiphertexts: string[];
}

/**
 * Lists the tables from sqlite_master (Cloudflare's internal `_cf_*` tables are not readable and skipped),
 * reads each one whole and looks for every marker, secret shape and run secret value (`secrets`, exact match).
 * Then checks that no stored refresh ciphertext base64-decodes to a token prefix.
 */
export async function scanD1(mode: D1Mode, markers: readonly Needle[], secrets: readonly string[] = []): Promise<ScanResult> {
  const listed = await d1Query<{ name: string }>(mode, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  const tables = listed.filter(({ name }) => !name.startsWith(INTERNAL_TABLE_PREFIX));
  const result: ScanResult = { tables: [], hits: [], refreshCiphertexts: [] };
  for (const { name } of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      result.hits.push(`${name}: unexpected table name`);
      continue;
    }
    const rows = await d1Query(mode, `SELECT * FROM "${name}"`);
    result.tables.push({ name, rows: rows.length });
    if (name === "accounts") {
      for (const row of rows) if (typeof row.refresh_ct === "string") result.refreshCiphertexts.push(row.refresh_ct);
    }
    const text = JSON.stringify(name === "accounts" ? rows.map(maskCiphertext) : rows);
    for (const hit of findNeedles(text, [...markers, ...TOKEN_SHAPES], secrets)) result.hits.push(`${name}: ${hit}`);
  }
  for (const ct of result.refreshCiphertexts) {
    const decoded = Buffer.from(ct, "base64").toString("latin1");
    if (decoded.includes("1//") || decoded.includes("ya29.")) result.hits.push("accounts: refresh_ct decodes to a token prefix");
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode: D1Mode = args.includes("--remote") ? "remote" : "local";
  const markers: Needle[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--marker" && args[i + 1]) markers.push({ name: `marker ${i}`, needle: args[++i] ?? "" });
  const scan = await scanD1(mode, markers);
  console.log(`tables: ${scan.tables.map((t) => `${t.name}(${t.rows})`).join(" ")}`);
  console.log(`refresh ciphertexts sampled: ${scan.refreshCiphertexts.length}`);
  console.log(scan.hits.length === 0 ? "CLEAN" : `HITS: ${scan.hits.join("; ")}`);
  process.exitCode = scan.hits.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`d1-scan failed: ${e instanceof Error ? e.message : "error"}`);
    process.exitCode = 2;
  });
}

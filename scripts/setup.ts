// Stands up a remote gws-mcp on your own Cloudflare account, or re-checks one. Idempotent: every step reuses what
// already exists, so running it again changes nothing that is in place.
//
//  1. Config: wrangler.jsonc (gitignored), created from wrangler.example.jsonc when absent with the Worker name set to
//     the prefix. An existing wrangler.jsonc is used only when its Worker name is the prefix and it is a real-Google
//     config (no fake upstream, no FAKE_GOOGLE binding).
//  2. Resources: D1 `<prefix>` and KV `<prefix>-oauth` / `<prefix>-cache`, found by exact name in the account's lists
//     and created only when missing, with `--update-config=false` (wrangler never edits a config). Their ids are then
//     written into wrangler.jsonc in place, comments kept. Nothing for the fake Google or the E2E Worker is created.
//     A binding that already holds a real (non-placeholder) id is never repointed: unless that id is exactly the
//     resource found by name, the run stops (exit 2) before creating, migrating, setting or deploying anything.
//  3. Migrations: applied to the remote D1.
//  4. Secrets, each value over wrangler's stdin, never in argv, output or a file. They come before the deploy, which
//     fails while a `secrets.required` name is unset (wrangler creates the Worker on the first put). TOKEN_ENC_KEY is
//     generated (32 random bytes) only when the Worker has none; an existing one is never replaced, since every stored
//     Google token depends on it. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set together when either is missing,
//     read from a hidden prompt, or from the first two non-empty lines of stdin when stdin is not a terminal.
//  5. Deploy: the top level only (`--env=""`).
//  6. Prints the Google redirect URI to register: PUBLIC_BASE_URL when the config sets it, else the workers.dev URL
//     wrangler reports for the deploy.
//
// Every wrangler command passes `--config wrangler.jsonc`; pin the account with "account_id" there or with
// CLOUDFLARE_ACCOUNT_ID (wrangler refuses to guess between accounts when it cannot prompt).
//
// Usage: npm run setup [-- --prefix <name>]      (default prefix gws-mcp)
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type SpawnLike, generateKey, runWrangler, scrub, secretNames } from "./put-secrets";
import { CONFIGS, ROOT, configVar, jsoncField, jsoncValue, parseJsoncTree, type JsoncNode } from "./wrangler";

export const DEFAULT_PREFIX = "gws-mcp";
/** Lowercase letters, digits and inner hyphens: valid for a Worker, a D1 database and a KV title, with room for "-oauth". */
const PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KV_ID = /^[0-9a-f]{32}$/;
const GOOGLE_CLIENT_ID = /^[A-Za-z0-9._-]{1,180}\.apps\.googleusercontent\.com$/;
/** Printable ASCII without spaces. */
const GOOGLE_CLIENT_SECRET = /^[\x21-\x7e]{8,200}$/;
const STDERR_TAIL_LINES = 20;

export interface WranglerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GoogleClient {
  id: string;
  secret: string;
}

export interface SetupDeps {
  /** Repository root (holds wrangler.jsonc and wrangler.example.jsonc). */
  root: string;
  /** Runs `npx wrangler <args>` with `stdin` written to the child's stdin; secret values travel only there. */
  wrangler: (args: readonly string[], stdin?: string) => Promise<WranglerResult>;
  /** Reads the Google client from a hidden prompt or stdin; null when nothing was given. Values are never logged. */
  readGoogleClient: () => Promise<GoogleClient | null>;
  generateKey: () => string;
  log: (line: string) => void;
}

/** The Google client from stdin text: the first two non-empty lines (id, then secret), trimmed; null if fewer. */
export function parseClientLines(text: string): GoogleClient | null {
  const [id, secret] = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return id !== undefined && secret !== undefined ? { id, secret } : null;
}

/** Names of the malformed Google client fields (never their values). */
export function invalidClientFields(client: GoogleClient): string[] {
  return [
    ...(GOOGLE_CLIENT_ID.test(client.id) ? [] : ["GOOGLE_CLIENT_ID (expected <id>.apps.googleusercontent.com)"]),
    ...(GOOGLE_CLIENT_SECRET.test(client.secret) ? [] : ["GOOGLE_CLIENT_SECRET (expected 8-200 printable characters, no spaces)"]),
  ];
}

/** The JSON array wrangler printed (it may print a banner first). */
function jsonArray(stdout: string): unknown[] | null {
  const start = stdout.indexOf("[");
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `field` of the first item whose `match` field equals `name`, or undefined. */
function idByName(items: unknown[], match: string, name: string, field: string): string | undefined {
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec[match] === name && typeof rec[field] === "string") return rec[field];
  }
  return undefined;
}

/** True when wrangler's `secret list` failed only because the Worker does not exist yet. */
export function workerNotFound(res: WranglerResult, name: string): boolean {
  return res.code !== 0 && `${res.stdout}\n${res.stderr}`.includes(`Worker "${name}" not found.`);
}

/** The first workers.dev origin in wrangler's deploy output, if any. */
export function deployedOrigin(stdout: string): string | undefined {
  const m = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/.exec(stdout);
  return m?.[0];
}

interface ConfigIds {
  databaseName: string;
  databaseId: string;
  oauthKvId: string;
  cacheKvId: string;
}

/** The object in array field `arrayKey` whose `binding` is `binding`. */
function bindingObject(root: JsoncNode, arrayKey: string, binding: string): JsoncNode | undefined {
  const arr = jsoncField(root, arrayKey);
  if (arr?.kind !== "array") return undefined;
  return arr.items.find((item) => {
    const b = jsoncField(item, "binding");
    return b?.kind === "string" && b.value === binding;
  });
}

/**
 * Writes the resource ids into the config text in place (comments and layout kept). Throws when the config does not
 * have the DB, OAUTH_KV and CACHE_KV bindings with string fields to fill.
 */
export function withResourceIds(text: string, ids: ConfigIds): string {
  const root = parseJsoncTree(text);
  const db = bindingObject(root, "d1_databases", "DB");
  const targets: Array<[JsoncNode | undefined, string, string]> = [
    [jsoncField(db, "database_name"), "d1_databases DB database_name", ids.databaseName],
    [jsoncField(db, "database_id"), "d1_databases DB database_id", ids.databaseId],
    [jsoncField(bindingObject(root, "kv_namespaces", "OAUTH_KV"), "id"), "kv_namespaces OAUTH_KV id", ids.oauthKvId],
    [jsoncField(bindingObject(root, "kv_namespaces", "CACHE_KV"), "id"), "kv_namespaces CACHE_KV id", ids.cacheKvId],
  ];
  const edits = targets.map(([node, where, value]) => {
    if (node?.kind !== "string") throw new Error(`${CONFIGS.main.local} has no string ${where} to fill`);
    return { start: node.start, end: node.end, value };
  });
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + JSON.stringify(e.value) + out.slice(e.end);
  return out;
}

const BINDINGS = ["DB", "OAUTH_KV", "CACHE_KV"] as const;
type Binding = (typeof BINDINGS)[number];

/** An id the example ships as a stand-in: zeros (and dashes), then at most two characters. */
export function isPlaceholderId(id: string): boolean {
  return /^[0-]+[0-9a-f]{0,2}$/.test(id);
}

/** The real (non-placeholder) ids the config's DB, OAUTH_KV and CACHE_KV bindings already hold. */
export function configuredIds(text: string): Record<Binding, string | undefined> {
  const root = parseJsoncTree(text);
  const value = (node: JsoncNode | undefined) => (node?.kind === "string" && !isPlaceholderId(node.value) ? node.value : undefined);
  return {
    DB: value(jsoncField(bindingObject(root, "d1_databases", "DB"), "database_id")),
    OAUTH_KV: value(jsoncField(bindingObject(root, "kv_namespaces", "OAUTH_KV"), "id")),
    CACHE_KV: value(jsoncField(bindingObject(root, "kv_namespaces", "CACHE_KV"), "id")),
  };
}

/** The example with its Worker name set to the prefix. */
function configFromExample(example: string, prefix: string): string {
  const name = jsoncField(parseJsoncTree(example), "name");
  if (name?.kind !== "string") throw new Error(`${CONFIGS.main.example} has no top-level "name"`);
  return example.slice(0, name.start) + JSON.stringify(prefix) + example.slice(name.end);
}

/** Why an existing config must not be used for this prefix, or null. */
function configRefusal(config: Record<string, unknown>, prefix: string): string | null {
  if (config.name !== prefix) {
    return `${CONFIGS.main.local} is for Worker "${String(config.name)}", not "${prefix}": pass --prefix ${String(config.name)}, or move that file away`;
  }
  return upstreamRefusal(config);
}

/**
 * Why a config must not be deployed as production, or null: production runs real Google, so GOOGLE_UPSTREAM must be
 * "google" and nothing may bind FAKE_GOOGLE. Shared by setup and update.
 */
export function upstreamRefusal(config: Record<string, unknown>): string | null {
  const services = Array.isArray(config.services) ? config.services : [];
  const bindsFake = services.some((s) => typeof s === "object" && s !== null && (s as Record<string, unknown>).binding === "FAKE_GOOGLE");
  if (bindsFake || configVar(config, "GOOGLE_UPSTREAM") !== "google") {
    return `${CONFIGS.main.local} is not a real-Google config (GOOGLE_UPSTREAM must be "google" and nothing may bind FAKE_GOOGLE)`;
  }
  return null;
}

/** Writes through a sibling temp file and a rename, so a failed write cannot truncate the config. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Returns the process exit code: 0 ok, 1 a wrangler or config failure, 2 a refusal, 64 a usage error. */
export async function setup(prefix: string, deps: SetupDeps): Promise<{ exitCode: number }> {
  const { log } = deps;
  if (!PREFIX.test(prefix)) {
    log("usage: --prefix must be 1-50 lowercase letters, digits or inner hyphens");
    return { exitCode: 64 };
  }
  const configPath = path.join(deps.root, CONFIGS.main.local);
  const secretsSeen: string[] = [];
  const fail = (what: string, res: WranglerResult): { exitCode: number } => {
    log(`FAILED: ${what} (exit ${res.code})`);
    const tail = scrub(res.stderr, secretsSeen).trimEnd().split("\n").slice(-STDERR_TAIL_LINES);
    for (const line of tail) if (line.trim() !== "") log(`  ${line}`);
    return { exitCode: 1 };
  };
  const wrangler = (args: readonly string[], stdin?: string) => deps.wrangler([...args, "--config", configPath], stdin);

  // 1. Config.
  if (existsSync(configPath)) {
    let refusal: string | null;
    try {
      refusal = configRefusal(jsoncValue(parseJsoncTree(readFileSync(configPath, "utf8"))) as Record<string, unknown>, prefix);
    } catch (e) {
      log(`FAILED: ${CONFIGS.main.local} is not valid JSONC (${e instanceof Error ? e.message : "unreadable"})`);
      return { exitCode: 1 };
    }
    if (refusal) {
      log(`REFUSED: ${refusal}; nothing was changed`);
      return { exitCode: 2 };
    }
    log(`config ${CONFIGS.main.local}: present (Worker ${prefix})`);
  } else {
    writeAtomic(configPath, configFromExample(readFileSync(path.join(deps.root, CONFIGS.main.example), "utf8"), prefix));
    log(`config ${CONFIGS.main.local}: created from ${CONFIGS.main.example} (Worker ${prefix})`);
  }

  // 2. Resources, by exact name; created only when missing. A binding that already holds a real id is never
  // repointed: the id must be exactly the resource found by name, else the run stops before anything changes (a
  // repointed binding would serve the live Worker from new, empty stores).
  let current: Record<Binding, string | undefined>;
  try {
    current = configuredIds(readFileSync(configPath, "utf8"));
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : "could not read the resource ids"}`);
    return { exitCode: 1 };
  }
  const names: Record<Binding, string> = { DB: prefix, OAUTH_KV: `${prefix}-oauth`, CACHE_KV: `${prefix}-cache` };
  const listD1 = () => wrangler(["d1", "list", "--json"]);
  const listKv = () => wrangler(["kv", "namespace", "list"]);
  let d1 = await listD1();
  if (d1.code !== 0) return fail("could not list D1 databases", d1);
  let kv = await listKv();
  if (kv.code !== 0) return fail("could not list KV namespaces", kv);
  const findId = (binding: Binding) =>
    binding === "DB" ? idByName(jsonArray(d1.stdout) ?? [], "name", names.DB, "uuid") : idByName(jsonArray(kv.stdout) ?? [], "title", names[binding], "id");
  for (const binding of BINDINGS) {
    const configured = current[binding];
    const found = findId(binding);
    if (configured !== undefined && configured !== found) {
      log(
        `REFUSED: ${CONFIGS.main.local} already points ${binding} at another resource than ${names[binding]} (${
          found === undefined ? `no ${binding === "DB" ? "D1 database" : "KV namespace"} of that name exists` : "that name has another id"
        }); setup never repoints a live binding, so fix the config or the prefix by hand; nothing was changed`,
      );
      return { exitCode: 2 };
    }
  }

  const ids = {} as Record<Binding, string>;
  for (const binding of BINDINGS) {
    const name = names[binding];
    const kind = binding === "DB" ? "d1" : "kv";
    let id = findId(binding);
    if (id === undefined) {
      const created = await wrangler(binding === "DB" ? ["d1", "create", name, "--update-config=false"] : ["kv", "namespace", "create", name, "--update-config=false"]);
      if (created.code !== 0) return fail(`could not create ${kind === "d1" ? "D1" : "KV"} ${name}`, created);
      if (binding === "DB") {
        d1 = await listD1();
        if (d1.code !== 0) return fail("could not list D1 databases", d1);
      } else {
        kv = await listKv();
        if (kv.code !== 0) return fail("could not list KV namespaces", kv);
      }
      id = findId(binding);
      log(`${kind} ${name}: created`);
    } else {
      log(`${kind} ${name}: exists`);
    }
    if (id === undefined || !(binding === "DB" ? D1_ID : KV_ID).test(id)) {
      log(`FAILED: no usable id for ${kind === "d1" ? "D1" : "KV"} ${name} in wrangler's list`);
      return { exitCode: 1 };
    }
    ids[binding] = id;
  }
  let text: string;
  try {
    const before = readFileSync(configPath, "utf8");
    text = withResourceIds(before, { databaseName: prefix, databaseId: ids.DB, oauthKvId: ids.OAUTH_KV, cacheKvId: ids.CACHE_KV });
    if (text !== before) writeAtomic(configPath, text);
    log(`config ${CONFIGS.main.local}: resource ids ${text === before ? "unchanged" : "written"}`);
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : "could not write the resource ids"}`);
    return { exitCode: 1 };
  }

  // 3. Migrations.
  const migrated = await wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  if (migrated.code !== 0) return fail("could not apply the D1 migrations", migrated);
  log(`d1 ${prefix}: migrations applied`);

  // 4. Secrets: names are listed (wrangler never returns values); nothing is replaced. A Worker that does not exist
  // yet has none: wrangler reports exactly that (from Cloudflare's not-found error code), and any other failure stops.
  const listed = await wrangler(["secret", "list", "--name", prefix, "--format", "json"]);
  const present = listed.code === 0 ? secretNames(listed.stdout) : workerNotFound(listed, prefix) ? new Set<string>() : null;
  if (!present) return fail(`could not list the secrets of ${prefix}, so none was set`, listed);

  const put = async (name: string, value: string): Promise<WranglerResult> => {
    secretsSeen.push(value);
    return wrangler(["secret", "put", name, "--name", prefix], value);
  };
  if (present.has("TOKEN_ENC_KEY")) {
    log("secret TOKEN_ENC_KEY: present, kept (every stored Google token depends on it)");
  } else {
    const res = await put("TOKEN_ENC_KEY", deps.generateKey());
    if (res.code !== 0) return fail("could not set TOKEN_ENC_KEY", res);
    log("secret TOKEN_ENC_KEY: generated and set");
  }
  if (present.has("GOOGLE_CLIENT_ID") && present.has("GOOGLE_CLIENT_SECRET")) {
    log("secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: present, kept");
  } else {
    log("Google OAuth client: enter its id and secret (the redirect URI to add to it is printed at the end)");
    const client = await deps.readGoogleClient();
    if (client === null) {
      log("BLOCKED: no Google client id and secret were given; run setup again with them (hidden prompt, or two stdin lines)");
      return { exitCode: 2 };
    }
    secretsSeen.push(client.id, client.secret);
    const bad = invalidClientFields(client);
    if (bad.length > 0) {
      log(`BLOCKED: malformed ${bad.join("; ")}; nothing was set`);
      return { exitCode: 2 };
    }
    for (const [name, value] of [
      ["GOOGLE_CLIENT_ID", client.id],
      ["GOOGLE_CLIENT_SECRET", client.secret],
    ] as const) {
      const res = await put(name, value);
      if (res.code !== 0) return fail(`could not set ${name}`, res);
      log(`secret ${name}: set`);
    }
  }

  // 5. Deploy (top level only).
  const deployed = await wrangler(["deploy", "--env="]);
  if (deployed.code !== 0) return fail(`could not deploy ${prefix}`, deployed);
  log(`worker ${prefix}: deployed`);

  // 6. The redirect URI to register.
  const configured = configVar(jsoncValue(parseJsoncTree(text)) as Record<string, unknown>, "PUBLIC_BASE_URL");
  const origin = configured ?? deployedOrigin(deployed.stdout);
  const redirectUri = origin === undefined ? undefined : `${origin.replace(/\/+$/, "")}/google/callback`;
  log(
    redirectUri === undefined
      ? "redirect URI: https://<your Worker's host>/google/callback (wrangler reported no workers.dev URL; use your route or custom domain)"
      : `redirect URI: ${redirectUri}`,
  );
  log("  register it under Authorized redirect URIs of your Google OAuth client (docs/self-host-google-client.md)");

  log(`done: ${prefix} is deployed`);
  return { exitCode: 0 };
}

/** Reads one line from the terminal without echoing it. Ctrl-C rejects. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    const done = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    process.stderr.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readGoogleClientFromUser(): Promise<GoogleClient | null> {
  if (!process.stdin.isTTY) return parseClientLines(readFileSync(0, "utf8"));
  const id = (await promptHidden("Google OAuth client id (hidden): ")).trim();
  const secret = (await promptHidden("Google OAuth client secret (hidden): ")).trim();
  return id && secret ? { id, secret } : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let prefix = DEFAULT_PREFIX;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prefix" && argv[i + 1] !== undefined) prefix = argv[++i] as string;
    else {
      console.error("usage: npm run setup [-- --prefix <name>]");
      process.exitCode = 64;
      return;
    }
  }
  const spawn = nodeSpawn as unknown as SpawnLike;
  const { exitCode } = await setup(prefix, {
    root: ROOT,
    wrangler: (args, stdin) => runWrangler(spawn, args, stdin ?? ""),
    readGoogleClient: readGoogleClientFromUser,
    generateKey,
    log: (line) => console.log(line),
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    // Only the error class: a message could in theory quote input.
    console.error(`setup: failed (${e instanceof Error ? e.name : "unknown error"})`);
    process.exitCode = 1;
  });
}

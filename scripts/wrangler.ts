// Runs wrangler with an explicit `--config`: the operator's untracked config when present, else the tracked example.
//
// Three Workers, each with its own config pair (the local file is gitignored, the example is tracked):
//   main  wrangler.jsonc               / wrangler.example.jsonc               production gws-mcp (real Google)
//   e2e   wrangler.e2e.jsonc           / wrangler.e2e.example.jsonc           fake-mode E2E Worker, bound to the fake
//   fake  fake-google/wrangler.jsonc   / fake-google/wrangler.example.jsonc   the fake Google Worker
//
// The example has placeholder resource ids and no account, so it only serves commands that stay on this machine
// (`dev` without `-r`/`--remote`, `--local`, `--dry-run`). Anything that reaches Cloudflare needs the local config and
// is refused (exit 2, nothing run) without it. A non-empty `--env` is refused for every config: each holds one
// top-level Worker, so an env could only select a stale block. The config is always passed explicitly, so wrangler never picks up some
// other config by searching parent directories.
//
// Usage: npx tsx scripts/wrangler.ts <main|e2e|fake> <wrangler args...>
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIGS = {
  main: { local: "wrangler.jsonc", example: "wrangler.example.jsonc" },
  e2e: { local: "wrangler.e2e.jsonc", example: "wrangler.e2e.example.jsonc" },
  fake: { local: path.join("fake-google", "wrangler.jsonc"), example: path.join("fake-google", "wrangler.example.jsonc") },
} as const;
export type ConfigKind = keyof typeof CONFIGS;

export function isConfigKind(value: string): value is ConfigKind {
  return Object.hasOwn(CONFIGS, value);
}

/** The operator's local config of `kind`, as an absolute path. */
export function localConfigPath(kind: ConfigKind, root = ROOT): string {
  return path.join(root, CONFIGS[kind].local);
}

/** The local config when it exists, else the tracked example. */
export function pickConfig(kind: ConfigKind, root = ROOT, exists: (file: string) => boolean = existsSync): { path: string; local: boolean } {
  const local = localConfigPath(kind, root);
  return exists(local) ? { path: local, local: true } : { path: path.join(root, CONFIGS[kind].example), local: false };
}

/** `-r`, `--remote` or `--remote=<anything>` (wrangler's `remote` flag and its alias), whatever the value. */
const REMOTE_FLAG = /^(-r|--remote)(=.*)?$/;

/** True unless the wrangler command provably stays on this machine. */
export function reachesCloudflare(args: readonly string[]): boolean {
  if (args.some((a) => REMOTE_FLAG.test(a))) return true;
  if (args.includes("--local") || args.includes("--dry-run")) return false;
  return args[0] !== "dev";
}

/**
 * True when the args select a non-empty wrangler environment (`-e`/`--env` with a value, or with none following).
 * Each config is a single top-level Worker, so only the empty env, which pins the top level, is allowed.
 */
export function namesEnv(args: readonly string[]): boolean {
  return args.some((a, i) => {
    const m = /^(-e|--env)(?:=([^]*))?$/.exec(a);
    if (!m) return false;
    const value = m[2] ?? args[i + 1];
    return value === undefined || value !== "";
  });
}

export type WranglerArgv = { ok: true; argv: string[]; config: string } | { ok: false; message: string };

/** The wrangler argv for `kind`, or why it must not run. */
export function wranglerArgv(kind: ConfigKind, args: readonly string[], root = ROOT, exists: (file: string) => boolean = existsSync): WranglerArgv {
  if (args.length === 0) return { ok: false, message: "usage: wrangler.ts <main|e2e|fake> <wrangler args...>" };
  if (args.some((a) => a === "-c" || a === "--config" || a.startsWith("--config=") || a.startsWith("-c="))) {
    return { ok: false, message: "refused: the config is chosen by scripts/wrangler.ts; do not pass -c/--config" };
  }
  if (namesEnv(args)) {
    return { ok: false, message: "refused: --env must be empty; each config holds one top-level Worker (nothing was run)" };
  }
  const picked = pickConfig(kind, root, exists);
  if (!picked.local && reachesCloudflare(args)) {
    return {
      ok: false,
      message: `refused: ${CONFIGS[kind].local} is missing, and ${CONFIGS[kind].example} is only a template (no account, placeholder ids) for local commands; nothing was run. ${
        kind === "main" ? "Run `npm run setup`, or copy" : "Copy"
      } ${CONFIGS[kind].example} to ${CONFIGS[kind].local} and fill in your own ids.`,
    };
  }
  return { ok: true, argv: [...args, "--config", picked.path], config: picked.path };
}

/** A JSONC value with its source span (`end` exclusive; a string's span includes its quotes). */
export type JsoncNode =
  | { kind: "object"; start: number; end: number; entries: Array<{ key: string; value: JsoncNode }> }
  | { kind: "array"; start: number; end: number; items: JsoncNode[] }
  | { kind: "string"; start: number; end: number; value: string }
  | { kind: "literal"; start: number; end: number; value: number | boolean | null };

const MAX_DEPTH = 64;

/**
 * Parses JSONC (JSON plus `//` and block comments and trailing commas, as wrangler accepts) into nodes that keep
 * their source spans, so a value can be replaced in place with every comment kept. Throws on malformed input; the
 * message gives an offset, never content.
 */
export function parseJsoncTree(text: string): JsoncNode {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`invalid JSONC: ${what} at offset ${i}`);
  };
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i] as string)) i++;
      if (text.startsWith("//", i)) {
        const end = text.indexOf("\n", i);
        i = end < 0 ? text.length : end;
      } else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("unterminated comment");
        i = end + 2;
      } else {
        return;
      }
    }
  };
  const str = (): Extract<JsoncNode, { kind: "string" }> => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") fail("newline in a string");
      i += text[i] === "\\" ? 2 : 1;
    }
    if (i >= text.length) fail("unterminated string");
    i++;
    return { kind: "string", start, end: i, value: JSON.parse(text.slice(start, i)) as string };
  };
  /** After an item: a comma (a trailing one allowed) or the closing bracket. True when the container closed. */
  const closeOrComma = (close: string): boolean => {
    skip();
    if (text[i] === ",") {
      i++;
      skip();
      if (text[i] !== close) return false;
    }
    if (text[i] !== close) fail(`expected ',' or '${close}'`);
    i++;
    return true;
  };
  const value = (depth: number): JsoncNode => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    skip();
    const start = i;
    if (text[i] === "{") {
      i++;
      const entries: Array<{ key: string; value: JsoncNode }> = [];
      skip();
      if (text[i] === "}") {
        i++;
        return { kind: "object", start, end: i, entries };
      }
      for (;;) {
        skip();
        if (text[i] !== '"') fail("expected a key");
        const key = str().value;
        skip();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        entries.push({ key, value: value(depth + 1) });
        if (closeOrComma("}")) return { kind: "object", start, end: i, entries };
      }
    }
    if (text[i] === "[") {
      i++;
      const items: JsoncNode[] = [];
      skip();
      if (text[i] === "]") {
        i++;
        return { kind: "array", start, end: i, items };
      }
      for (;;) {
        items.push(value(depth + 1));
        if (closeOrComma("]")) return { kind: "array", start, end: i, items };
      }
    }
    if (text[i] === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) return fail("unexpected token");
    i += m[0].length;
    return { kind: "literal", start, end: i, value: JSON.parse(m[0]) as number | boolean | null };
  };
  const root = value(0);
  skip();
  if (i !== text.length) fail("trailing content");
  return root;
}

/** The plain value of a node. Keys are defined as own properties, so a `__proto__` key stays a plain key. */
export function jsoncValue(node: JsoncNode): unknown {
  switch (node.kind) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const { key, value } of node.entries) {
        Object.defineProperty(out, key, { value: jsoncValue(value), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case "array":
      return node.items.map(jsoncValue);
    default:
      return node.value;
  }
}

/** Parses JSONC text into a plain value. */
export function parseJsonc(text: string): unknown {
  return jsoncValue(parseJsoncTree(text));
}

/** The last entry `key` of an object node (the one a parser keeps), if any. */
export function jsoncField(node: JsoncNode | undefined, key: string): JsoncNode | undefined {
  if (node?.kind !== "object") return undefined;
  return node.entries.findLast((e) => e.key === key)?.value;
}

/** A wrangler config file parsed as JSONC. */
export function readWranglerConfig(file: string): Record<string, unknown> {
  const parsed = parseJsonc(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path.basename(file)} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** A string var from a parsed config's top-level `vars`, if set. */
export function configVar(config: Record<string, unknown>, name: string): string | undefined {
  const vars = config.vars;
  if (typeof vars !== "object" || vars === null) return undefined;
  const value = (vars as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function main(): void {
  const [kind = "", ...args] = process.argv.slice(2);
  if (!isConfigKind(kind)) {
    console.error(`usage: wrangler.ts <${Object.keys(CONFIGS).join("|")}> <wrangler args...>`);
    process.exitCode = 64;
    return;
  }
  const res = wranglerArgv(kind, args);
  if (!res.ok) {
    console.error(res.message);
    process.exitCode = 2;
    return;
  }
  console.error(`wrangler.ts: using ${path.relative(ROOT, res.config)}`);
  const child = spawn("npx", ["wrangler", ...res.argv], { cwd: ROOT, stdio: "inherit", shell: false });
  child.on("error", (e) => {
    console.error(`wrangler.ts: could not start wrangler (${e.name})`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

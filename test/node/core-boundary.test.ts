import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The platform-free core (the dispatcher, registry, write guard, limits, search, helpers, accounts capability,
 * execute orchestration, MCP tool definitions, the generated SDK and the compat layer) must compile and run in
 * both runtimes. Starting from it, this follows every import, transitively, and fails on anything that ties a
 * reached file to Cloudflare: a `cloudflare:*` or other non-allowlisted module, the Worker `Env`, a D1/KV or
 * other Workers platform type, or a runtime, transport, store or web module (the core reaches those only
 * through the ports in src/core/ports.ts). The scan reads the TypeScript syntax tree, so comments and strings
 * never count and type-only imports do. A second check compiles the core with Node types only: any Workers
 * ambient name (a type or a global such as `caches`) is then a compile error, whatever its name. In the other
 * direction, the Workers wiring never reaches the local runtime (src/local) or the Node host (src/runtime/node), and
 * the Node host reaches the local runtime only for its sandbox and Cloudflare-only modules only through the
 * stand-ins its bundle aliases.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Where the import graph starts: every core file. */
const CORE_DIRS = ["src/core", "src/sdk"];
const CORE_FILES = ["src/google/request.ts", "src/google/media.ts", "src/google/errors.ts", "src/google/paginate.ts"];

/** The only packages a core file may import. */
const ALLOWED_PACKAGES: ReadonlySet<string> = new Set(["zod"]);

/** Modules the core may never reach, even indirectly: they hold the platform adapters and the HTTP layers. */
const FORBIDDEN_PATHS = ["src/runtime/", "src/local/", "src/store/", "src/mcp/", "src/web/", "src/auth/", "src/index.ts"];

/** Globals the core may not index by key: a string key reaches an ambient binding the compile check cannot see. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "self", "global", "window"]);

/** The Workers wiring: it must never reach src/local, where the local runtime's single-user adapters live. */
const WORKERS_WIRING_DIRS = ["src/runtime/workers", "src/mcp", "src/web", "src/auth"];
const WORKERS_WIRING_FILES = ["src/index.ts"];
const LOCAL_RUNTIME = "src/local";

/** The Node host: the Worker app on Node. Its bundle aliases `cloudflare:workers` and the Workers sandbox module. */
const NODE_HOST_DIR = "src/runtime/node";
/** The only local-runtime files the Node host may reach: the worker-thread sandbox. */
const NODE_HOST_LOCAL_FILES: ReadonlySet<string> = new Set(["src/local/sandbox.ts", "src/local/sandbox-worker.ts"]);

/** Ambient Workers platform types: the Worker env, its bindings and its handler types. */
const PLATFORM_TYPE =
  /^(?:Env|Cloudflare|Fetcher|ExecutionContext|ExportedHandler|WorkerStub|ScheduledController|D1[A-Z]\w*|KVNamespace\w*|DurableObject\w*|WorkerLoader\w*|R2[A-Z]\w*)$/;

interface ScannedImport {
  specifier: string;
  line: number;
}

interface Scan {
  imports: ScannedImport[];
  violations: string[];
}

/** True for `globalThis` (or `self`, `global`, `window`), also behind parentheses, `as`, `satisfies` or `!`. */
function isGlobalObject(expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
    e = e.expression;
  }
  return ts.isIdentifier(e) && GLOBAL_OBJECTS.has(e.text);
}

/** Reads one source text: its module specifiers, and every platform tie that needs no resolution to see. */
function scanSource(fileName: string, text: string): Scan {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: ScannedImport[] = [];
  const violations: string[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const addSpecifier = (node: ts.Node, spec: ts.Node | undefined) => {
    if (spec && ts.isStringLiteralLike(spec)) imports.push({ specifier: spec.text, line: lineOf(node) });
    else violations.push(`${fileName}:${lineOf(node)}: a module specifier that is not a string literal`);
  };

  for (const ref of sf.typeReferenceDirectives) violations.push(`${fileName}: a /// <reference types="${ref.fileName}" /> directive`);
  for (const ref of sf.referencedFiles) violations.push(`${fileName}: a /// <reference path="${ref.fileName}" /> directive`);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) addSpecifier(node, node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) addSpecifier(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addSpecifier(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const arg = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      addSpecifier(node, arg);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) addSpecifier(node, node.arguments[0]);
    } else if (ts.isElementAccessExpression(node) && isGlobalObject(node.expression)) {
      violations.push(`${fileName}:${lineOf(node)}: a keyed access on a global object`);
    } else if (ts.isIdentifier(node) && PLATFORM_TYPE.test(node.text)) {
      violations.push(`${fileName}:${lineOf(node)}: the Workers platform name \`${node.text}\``);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, violations };
}

function rel(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

/** Every .ts file under `dir`, declaration files included: a `.d.ts` can declare globals for the whole program. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsFilesUnder(child));
    else if (entry.name.endsWith(".ts")) out.push(child);
  }
  return out;
}

/** The file a relative specifier names, as the bundler resolves it; undefined when there is none. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(ROOT, path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return rel(candidate);
  }
  return undefined;
}

/** Checks one import of a core file: the source file it adds to the graph (null for a package), or why it is not allowed. */
function checkImport(file: string, { specifier, line }: ScannedImport): { next: string | null } | { violation: string } {
  const at = `${file}:${line}: imports "${specifier}"`;
  if (!specifier.startsWith(".")) {
    return ALLOWED_PACKAGES.has(specifier) ? { next: null } : { violation: `${at}, a module outside the core's allowlist` };
  }
  const target = resolveRelative(file, specifier.replace(/\?.*$/, ""));
  if (target === undefined) return { violation: `${at}, which resolves to no file` };
  if (!target.startsWith("src/") || FORBIDDEN_PATHS.some((p) => target === p || target.startsWith(p))) {
    return { violation: `${at}, which reaches ${target}` };
  }
  return { next: target };
}

/** Walks the import graph from `roots`; returns every file reached and every violation found. */
function scanGraph(roots: readonly string[]): { reached: string[]; violations: string[] } {
  const reached = new Set<string>();
  const violations: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    const scan = scanSource(file, readFileSync(path.join(ROOT, file), "utf8"));
    violations.push(...scan.violations);
    for (const imported of scan.imports) {
      const checked = checkImport(file, imported);
      if ("violation" in checked) violations.push(checked.violation);
      else if (checked.next !== null) queue.push(checked.next);
    }
  }
  return { reached: [...reached].sort(), violations };
}

const roots = [...CORE_DIRS.flatMap(tsFilesUnder), ...CORE_FILES];

/**
 * The core's compiler options with Node types only: no worker-configuration.d.ts, no Workers types. Otherwise
 * as strict as the repo's tsconfig.
 */
const NODE_ONLY: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2023.d.ts"],
  types: ["node"],
  typeRoots: [path.join(ROOT, "node_modules", "@types")],
  // Declaration files are checked too (only the default lib is skipped): a core `.d.ts` that names a Workers
  // type must fail, and skipLibCheck would skip it.
  skipDefaultLibCheck: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  resolveJsonModule: true,
};

/**
 * Compiles `files` (repo-relative) and the in-memory `probes` with Node types only; returns every diagnostic as
 * "file:line: TSnnnn message".
 */
function compileNodeOnly(files: readonly string[], probes: Readonly<Record<string, string>> = {}): string[] {
  const host = ts.createCompilerHost(NODE_ONLY, true);
  const virtual = new Map(Object.entries(probes).map(([f, text]) => [path.join(ROOT, f), text]));
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => virtual.has(path.normalize(f)) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(path.normalize(f)) ?? readFile.call(host, f);
  host.getSourceFile = (f, language, onError, shouldCreate) => {
    const text = virtual.get(path.normalize(f));
    return text !== undefined ? ts.createSourceFile(f, text, language) : getSourceFile.call(host, f, language, onError, shouldCreate);
  };
  const program = ts.createProgram([...files.map((f) => path.join(ROOT, f)), ...virtual.keys()], NODE_ONLY, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${rel(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : "(program)";
    return `${where}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
}

/** Files reached from `starts`, transitively, that import something under `forbidden` (present or not). */
function workersReachingLocal(starts: readonly string[], text: (file: string) => string, forbidden: string = LOCAL_RUNTIME): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  const queue = [...starts];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, line } of scanSource(file, text(file)).imports) {
      if (!specifier.startsWith(".")) continue;
      const clean = specifier.replace(/\?.*$/, "");
      const named = rel(path.resolve(ROOT, path.dirname(file), clean));
      if (named === forbidden || named.startsWith(`${forbidden}/`)) {
        violations.push(`${file}:${line}: imports "${specifier}", which is under ${forbidden}`);
        continue;
      }
      const target = resolveRelative(file, clean);
      if (target !== undefined && target.startsWith("src/")) queue.push(target);
    }
  }
  return violations;
}

const workersWiring = [...WORKERS_WIRING_DIRS.flatMap(tsFilesUnder), ...WORKERS_WIRING_FILES];
const readSource = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const nodeHost = tsFilesUnder(NODE_HOST_DIR);

/** Every source file reached from `starts` through relative imports, transitively (`?raw` assets excluded). */
function reachable(starts: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier } of scanSource(file, readSource(file)).imports) {
      if (!specifier.startsWith(".") || specifier.endsWith("?raw")) continue;
      const target = resolveRelative(file, specifier);
      if (target !== undefined && target.startsWith("src/")) queue.push(target);
    }
  }
  return seen;
}

describe("the platform-free core", () => {
  it("starts from every core file", () => {
    for (const file of ["src/core/ports.ts", "src/core/dispatch.ts", "src/core/execute.ts", "src/core/tools.ts", "src/sdk/index.ts"]) {
      expect(roots).toContain(file);
    }
    for (const file of roots) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
  });

  it("reaches no Cloudflare module, Worker env, platform type or adapter, however indirectly", () => {
    const { reached, violations } = scanGraph(roots);
    expect(violations).toEqual([]);
    // Neither runtime's adapters: the Workers wiring, nor the Node host and its node:* modules.
    expect(reached.filter((f) => f.startsWith("src/runtime/") || f.startsWith("src/local/"))).toEqual([]);
    // The shared modules the core really depends on are scanned too, not skipped.
    for (const file of ["src/contracts.ts", "src/config.ts", "src/errors.ts", "src/google/oauth.ts", "src/google/transport.ts", "src/google/client.ts"]) {
      expect(reached).toContain(file);
    }
  });

  it("compiles with Node types only, so no Workers type or global is used under any name", () => {
    expect(compileNodeOnly(roots)).toEqual([]);
  }, 120_000);
});

describe("the Workers wiring", () => {
  it("starts from the Workers runtime, the MCP wiring, the web and auth layers and the entry", () => {
    for (const file of ["src/runtime/workers/ports.ts", "src/runtime/workers/sandbox.ts", "src/mcp/server.ts", "src/web/app.ts", "src/index.ts"]) {
      expect(workersWiring).toContain(file);
    }
  });

  it("never reaches the local runtime, however indirectly", () => {
    expect(workersReachingLocal(workersWiring, readSource)).toEqual([]);
  });

  it("is caught importing the local runtime, directly or through another file", () => {
    const files: Record<string, string> = {
      "src/runtime/workers/probe.ts": 'import { localApproval } from "../../local/approval";',
      "src/mcp/probe.ts": 'export * from "../local";',
    };
    const text = (file: string) => files[file] ?? readSource(file);
    expect(workersReachingLocal(["src/runtime/workers/probe.ts"], text)).toHaveLength(1);
    expect(workersReachingLocal(["src/mcp/probe.ts"], text)).toHaveLength(1);
  });
});

describe("the Node host", () => {
  it("starts from every Node host file", () => {
    for (const file of ["main.ts", "access-command.ts", "backup-command.ts", "command-common.ts", "log.ts", "host.ts", "http.ts", "config.ts", "database.ts", "migrations.ts", "d1.ts", "kv.ts", "workers-sandbox.ts", "cloudflare-workers.ts"]) {
      expect(nodeHost).toContain(`${NODE_HOST_DIR}/${file}`);
    }
  });

  it("is never reached by the Workers wiring, so no node:* module enters the Worker bundle", () => {
    expect(workersReachingLocal(workersWiring, readSource, NODE_HOST_DIR)).toEqual([]);
    expect(workersReachingLocal(["src/runtime/workers/probe.ts"], (f) => (f === "src/runtime/workers/probe.ts" ? 'import "../node/d1";' : readSource(f)), NODE_HOST_DIR)).toHaveLength(1);
  });

  it("reaches the local runtime only for its sandbox", () => {
    const local = [...reachable(nodeHost)].filter((f) => f === LOCAL_RUNTIME || f.startsWith(`${LOCAL_RUNTIME}/`));
    expect(local.filter((f) => !NODE_HOST_LOCAL_FILES.has(f))).toEqual([]);
    expect(local).toContain("src/local/sandbox.ts");
  });

  it("imports no Cloudflare-only module itself; only the bundle's aliases stand in for them", () => {
    const direct = nodeHost.flatMap((file) =>
      scanSource(file, readSource(file))
        .imports.filter(({ specifier }) => specifier.startsWith("cloudflare:") || specifier.startsWith("@cloudflare/codemode") || /runtime\/workers\/sandbox$|^\.\.\/workers\/sandbox$/.test(specifier))
        .map(({ specifier, line }) => `${file}:${line}: imports "${specifier}"`),
    );
    expect(direct).toEqual([]);
  });
});

describe("the boundary scanner", () => {
  /** The violations of one synthetic core file at src/core/probe.ts (its relative imports resolve from there). */
  function caught(text: string): string[] {
    const file = "src/core/probe.ts";
    const scan = scanSource(file, text);
    const violations = [...scan.violations];
    for (const imported of scan.imports) {
      const checked = checkImport(file, imported);
      if ("violation" in checked) violations.push(checked.violation);
    }
    return violations;
  }

  it.each([
    ["a cloudflare:workers import", 'import { env } from "cloudflare:workers";'],
    ["a type-only cloudflare import", 'import type { WorkerEntrypoint } from "cloudflare:workers";'],
    ["a dynamic import", 'const m = await import("cloudflare:workers");'],
    ["a require", 'const m = require("cloudflare:sockets");'],
    ["an import type expression", 'type T = import("cloudflare:workers").WorkerEntrypoint;'],
    ["a re-export", 'export * from "cloudflare:workers";'],
    ["a Workers-only package", 'import { DynamicWorkerExecutor } from "@cloudflare/codemode";'],
    ["a types reference", '/// <reference types="@cloudflare/workers-types" />\nexport const x = 1;'],
    ["the Worker Env", "export function f(e: Env) { return e; }"],
    ["the namespaced Worker Env", "export type E = Cloudflare.Env;"],
    ["a D1 type", "export function f(db: D1Database) { return db; }"],
    ["a KV type", "export interface X { kv: KVNamespace }"],
    ["a Worker Loader type", "export const f = (l: WorkerLoader) => l;"],
    ["a service binding type", "export type F = Pick<Fetcher, 'fetch'>;"],
    ["an adapter module", 'import { workersPorts } from "../runtime/workers/ports";'],
    ["the D1 store", 'import { openStore } from "../store/db";'],
    ["the MCP wiring", 'import { createServer } from "../mcp/server";'],
    ["a Node builtin", 'import { DatabaseSync } from "node:sqlite";'],
    ["a bare Node builtin", 'import { readFileSync } from "fs";'],
    ["the Node host", 'import { startNodeHost } from "../runtime/node/host";'],
    ["a non-literal dynamic import", "const name = 'x'; export const m = import(name);"],
    ["a keyed access on globalThis", 'export const l = (globalThis as unknown as Record<string, unknown>)["LOADER"];'],
    ["a computed key on self", 'const k = "LOADER"; export const l = (self as any)[k];'],
  ])("catches %s", (_what, text) => {
    expect(caught(text).length).toBeGreaterThan(0);
  });

  it("fails the Node-only compile on Workers globals and types the name list does not know", () => {
    const probes: Record<string, string> = {
      "src/core/__probe_caches.ts": "export const c = caches.default;",
      "src/core/__probe_queue.ts": "export type Q = Queue<string>;",
      "src/core/__probe_socket.ts": "export const pair = new WebSocketPair();",
      "src/core/__probe_globals.d.ts": "declare const LOADER: WorkerLoader;",
      "src/core/__probe_clean.ts": 'import type { Config } from "../config";\nexport const f = (c: Config) => c.PUBLIC_BASE_URL;',
    };
    const diagnostics = compileNodeOnly([], probes);
    for (const probe of Object.keys(probes).filter((f) => !f.includes("clean"))) {
      expect(diagnostics.some((d) => d.startsWith(`${probe}:`)), probe).toBe(true);
    }
    expect(diagnostics.filter((d) => d.startsWith("src/core/__probe_clean.ts:"))).toEqual([]);
  }, 120_000);

  it("ignores comments, strings and look-alike names", () => {
    const text = [
      "// Env, KVNamespace and cloudflare:workers in a comment",
      "/** Reads `Env` and D1Database from the Worker. */",
      'export const s = "cloudflare:workers Env D1Database";',
      "export type ConfigEnv = { readonly ENV?: unknown; env?: unknown };",
      'import { z } from "zod";',
      'import type { Config } from "../config";',
    ].join("\n");
    expect(caught(text)).toEqual([]);
  });
});

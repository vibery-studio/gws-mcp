import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Metafile } from "esbuild";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLocal, localEntryPoints, RUNTIME_EXTERNALS } from "../../build/local";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
// Under node_modules so the bundle's external packages resolve from it, and git ignores it.
const OUT = path.join(ROOT, "node_modules", ".cache", `gws-mcp-local-build-${crypto.randomUUID()}`);

/** Modules of the Workers runtime that the local bundle must never contain, at any depth. */
const WORKERS_ONLY = /(?:^|\/)node_modules\/(?:@cloudflare\/|agents\/|wrangler\/|miniflare\/|workerd\/|hono\/)/;
const WORKERS_WIRING = /^src\/(?:runtime|mcp|web|auth)\/|^src\/index\.ts$/;

let meta: Metafile;
beforeAll(async () => {
  meta = await buildLocal(OUT);
}, 120_000);
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

const outputFiles = () => Object.keys(meta.outputs).filter((f) => f.endsWith(".js")).map((f) => path.resolve(ROOT, f));
const entryOutputs = () =>
  Object.entries(meta.outputs)
    .filter(([, o]) => o.entryPoint !== undefined)
    .map(([f, o]) => [o.entryPoint ?? "", path.resolve(ROOT, f)] as const);

describe("the local bundle", () => {
  it("has an entry for every top-level module of src/local", () => {
    expect(entryOutputs().map(([entry]) => entry).sort()).toEqual(localEntryPoints().map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort());
  });

  it("reaches no cloudflare:* module, Workers package or Workers wiring, at any depth", () => {
    const inputs = Object.keys(meta.inputs);
    const imported = [
      ...Object.values(meta.inputs).flatMap((i) => i.imports.map((x) => x.path)),
      ...Object.values(meta.outputs).flatMap((o) => o.imports.map((x) => x.path)),
    ];
    expect(imported.filter((p) => p.startsWith("cloudflare:"))).toEqual([]);
    expect(inputs.filter((f) => WORKERS_ONLY.test(f))).toEqual([]);
    expect(inputs.filter((f) => WORKERS_WIRING.test(f))).toEqual([]);
    for (const file of outputFiles()) expect([path.basename(file), readFileSync(file, "utf8").includes("cloudflare:")]).toEqual([path.basename(file), false]);
    // The only imports left for run time are Node built-ins and the declared runtime packages.
    const external = new Set(Object.values(meta.outputs).flatMap((o) => o.imports.filter((x) => x.external).map((x) => x.path)));
    const allowed = new Set<string>(RUNTIME_EXTERNALS);
    expect([...external].filter((p) => !p.startsWith("node:") && !allowed.has(p))).toEqual([]);
  });

  it("loads in plain Node, and its sandbox runs a snippet there", () => {
    const entries = entryOutputs().map(([, file]) => pathToFileURL(file).href);
    const sandbox = entryOutputs().find(([entry]) => entry === "src/local/sandbox.ts")?.[1];
    if (sandbox === undefined) throw new Error("no sandbox entry");
    const script = `
      for (const url of ${JSON.stringify(entries)}) await import(url);
      const { localSandbox } = await import(${JSON.stringify(pathToFileURL(sandbox).href)});
      const out = await localSandbox().run({ code: "async () => JSON.stringify(6 * 7)", prelude: "", call: async () => null,
        limits: { timeoutMs: 5000, cpuMs: 5000, memoryBytes: 1 << 26 } });
      process.stdout.write(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "--no-warnings", "-e", script], { cwd: path.dirname(OUT), encoding: "utf8" });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(r.stdout)).toEqual({ logs: [], result: "42" });
  });
});

describe("src/local compiled with Node types only", () => {
  it("uses no Workers type or global: the only diagnostics are the three that follow from db.ts naming D1Database", () => {
    const roots = [...localEntryPoints(), path.join(ROOT, "src", "local", "sql.d.ts")];
    const program = ts.createProgram(roots, {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts"],
      types: ["node"],
      skipLibCheck: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      resolveJsonModule: true,
    });
    const lines = ts
      .getPreEmitDiagnostics(program)
      .map((d) => {
        const file = d.file ? path.relative(ROOT, d.file.fileName).split(path.sep).join("/") : "(global)";
        return `${file}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
      })
      // Node 22 has these globals at run time (the bundle test above runs them), but @types/node does not declare them.
      .filter((line) => !/: TS(?:2304|2503) Cannot find (?:name|namespace) '(?:WebAssembly|CryptoKey)'\.$/.test(line));
    // src/store/db.ts types its binding as D1Database, which only Workers types declare (locally it runs over the
    // D1-compatible statements in src/local/store.ts). Exactly these diagnostics follow from that one name; any other
    // Workers type or global in db.ts would add a line here.
    expect(lines.sort()).toEqual([
      "src/store/db.ts: TS2304 Cannot find name 'D1Database'.",
      // The two `.all()` result rows, untyped once the binding's type is unknown.
      "src/store/db.ts: TS7006 Parameter 'r' implicitly has an 'any' type.",
      "src/store/db.ts: TS7006 Parameter 'r' implicitly has an 'any' type.",
    ]);
    // A whole-program type check of every local entry (the MCP SDK's types included) takes several seconds.
  }, 120_000);
});

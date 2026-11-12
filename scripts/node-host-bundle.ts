// Builds the Node host (the unchanged Worker app on Node) as a self-contained folder:
//
//   server.js               the host: src/runtime/node/main.ts, the Worker entry and every dependency, the D1
//                           migrations embedded
//   sandbox-worker.js       the snippet sandbox's thread (src/local/sandbox-worker.ts), loaded from beside server.js
//   emscripten-module.wasm  the QuickJS build, loaded from beside sandbox-worker.js
//   package.json            `"type": "module"`, so the folder runs anywhere with plain `node`
//
//   npx tsx scripts/node-host-bundle.ts [outdir]     (default: dist/node-host; `npm run build:node`)
//
// Two modules are resolved to Node stand-ins at build time (module aliasing): `cloudflare:workers` to
// src/runtime/node/cloudflare-workers.ts, and the Workers sandbox (src/runtime/workers/sandbox.ts, which needs the
// Worker Loader) to src/runtime/node/workers-sandbox.ts. No Workers source changes. The build fails if the Workers
// sandbox or @cloudflare/codemode would still be bundled, or a stand-in is missing.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE_HOST = path.join(ROOT, "src/runtime/node");
const WORKERS_SANDBOX = path.join(ROOT, "src/runtime/workers/sandbox.ts");
export const DEFAULT_OUTDIR = path.join(ROOT, "dist/node-host");
export const WASM_FILE = "emscripten-module.wasm";

/** `cloudflare:workers` to the Node env shim; the Workers sandbox module to the worker-thread one. */
const nodeHostAliases: Plugin = {
  name: "node-host-aliases",
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: path.join(NODE_HOST, "cloudflare-workers.ts") }));
    b.onResolve({ filter: /^\.\/sandbox$/ }, (args) =>
      path.join(args.resolveDir, "sandbox.ts") === WORKERS_SANDBOX ? { path: path.join(NODE_HOST, "workers-sandbox.ts") } : undefined,
    );
  },
};

/** `import sql from "x.sql?raw"`: the file's text (Vite's `?raw`, which the tests use). */
const rawText: Plugin = {
  name: "raw-text",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -"?raw".length)), namespace: "raw-text" }));
    b.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
  },
};

export interface NodeHostBundle {
  outdir: string;
  /** Source files bundled into server.js, repo-relative. */
  inputs: string[];
}

export async function bundleNodeHost(outdir: string = DEFAULT_OUTDIR): Promise<NodeHostBundle> {
  mkdirSync(outdir, { recursive: true });
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: { server: "src/runtime/node/main.ts", "sandbox-worker": "src/local/sandbox-worker.ts" },
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // CommonJS dependencies bundled into ESM still call require() for Node builtins.
    banner: { js: "import { createRequire as __gwsCreateRequire } from 'node:module'; const require = __gwsCreateRequire(import.meta.url);" },
    plugins: [nodeHostAliases, rawText],
    logLevel: "warning",
    metafile: true,
  });
  const serverInputs = Object.keys(result.metafile.outputs[path.relative(ROOT, path.join(outdir, "server.js")).split(path.sep).join("/")]?.inputs ?? {});
  const inputs = serverInputs.length > 0 ? serverInputs : Object.keys(result.metafile.inputs);
  const problems: string[] = [];
  if (inputs.includes("src/runtime/workers/sandbox.ts")) problems.push("the Workers sandbox module is bundled (the alias did not apply)");
  if (inputs.some((i) => i.includes("@cloudflare/codemode"))) problems.push("@cloudflare/codemode is bundled");
  for (const shim of ["src/runtime/node/cloudflare-workers.ts", "src/runtime/node/workers-sandbox.ts", "src/index.ts"]) {
    if (!inputs.includes(shim)) problems.push(`${shim} is not bundled`);
  }
  if (problems.length > 0) throw new Error(`node host bundle: ${problems.join("; ")}`);

  const require = createRequire(import.meta.url);
  copyFileSync(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"), path.join(outdir, WASM_FILE));
  writeFileSync(path.join(outdir, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`);
  return { outdir, inputs };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outdir = path.resolve(process.argv[2] ?? DEFAULT_OUTDIR);
  bundleNodeHost(outdir).then(
    ({ inputs }) => console.log(`node host bundled: ${inputs.length} inputs -> ${path.relative(process.cwd(), outdir) || "."} (server.js, sandbox-worker.js, ${WASM_FILE})`),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}

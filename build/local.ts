import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCAL_SRC = path.join(ROOT, "src", "local");

/**
 * Packages loaded at run time from node_modules instead of being bundled: a native addon (one prebuilt binary
 * per platform) and the QuickJS build, which reads its WebAssembly file next to its own code.
 */
export const RUNTIME_EXTERNALS = ["@napi-rs/keyring", "quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync"] as const;

/** `import text from "./file.sql?raw"`: the file's text, as Vite gives it in tests. */
const rawText: Plugin = {
  name: "raw-text",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -"?raw".length)),
      namespace: "raw-text",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw-text" }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
  },
};

/** Every top-level module of src/local is an entry point (`cli.ts` becomes dist/cli.js, the package's bin). */
export function localEntryPoints(): string[] {
  return readdirSync(LOCAL_SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.join(LOCAL_SRC, f));
}

/**
 * Bundles the local runtime (src/local and the platform-free core it imports) as Node ≥ 22 ESM into `outdir`,
 * which is emptied first. Shared code goes into chunks. Returns esbuild's metafile, which lists every module the
 * bundle reached.
 */
export async function buildLocal(outdir: string): Promise<Metafile> {
  rmSync(outdir, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: localEntryPoints(),
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: [...RUNTIME_EXTERNALS],
    plugins: [rawText],
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  return result.metafile;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outdir = path.join(ROOT, "dist");
  const meta = await buildLocal(outdir);
  const outputs = Object.keys(meta.outputs).filter((f) => f.endsWith(".js"));
  console.log(`build:local wrote ${outputs.length} files to ${path.relative(ROOT, outdir)}/`);
}

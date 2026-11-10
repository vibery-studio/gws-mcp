import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("request env", () => {
  it("only the Worker entry (its startup check) reads the module-level env; handlers get the request's env", () => {
    // `env` from "cloudflare:workers" never has the per-request PUBLIC_BASE_URL (src/config.ts publicBaseUrl), so a
    // handler reading config from it would build public URLs from the wrong origin, or fail when the var is unset.
    const readers = sourceFiles(SRC)
      .filter((file) => /import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["']cloudflare:workers["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(readers).toEqual(["index.ts"]);
  });
});

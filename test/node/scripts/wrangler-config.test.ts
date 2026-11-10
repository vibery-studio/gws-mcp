import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIGS, parseJsonc, parseJsoncTree, pickConfig, reachesCloudflare, wranglerArgv } from "../../../scripts/wrangler";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const ROOT = "/repo";
const only = (...files: string[]) => (file: string) => files.includes(file);

/** Every KV-shaped (32 hex) or D1-shaped (UUID) id in a text. */
const IDS = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/g;
/** A placeholder id: zeros, then at most two trailing characters. */
const PLACEHOLDER = /^[0-]+[0-9a-f]{0,2}$/;

describe("wrangler config picker", () => {
  it("uses the operator's local config when present, else the tracked example", () => {
    for (const kind of Object.keys(CONFIGS) as Array<keyof typeof CONFIGS>) {
      const local = path.join(ROOT, CONFIGS[kind].local);
      const example = path.join(ROOT, CONFIGS[kind].example);
      expect(pickConfig(kind, ROOT, only(local))).toEqual({ path: local, local: true });
      expect(pickConfig(kind, ROOT, only())).toEqual({ path: example, local: false });
    }
  });

  it("keeps each Worker on its own config: production never gets the E2E or fake config", () => {
    expect(CONFIGS.main).toEqual({ local: "wrangler.jsonc", example: "wrangler.example.jsonc" });
    expect(CONFIGS.e2e).toEqual({ local: "wrangler.e2e.jsonc", example: "wrangler.e2e.example.jsonc" });
    expect(CONFIGS.fake).toEqual({ local: path.join("fake-google", "wrangler.jsonc"), example: path.join("fake-google", "wrangler.example.jsonc") });
  });

  it("treats only dev, --local and --dry-run as staying on this machine", () => {
    for (const args of [["dev", "--port", "8787"], ["d1", "migrations", "apply", "DB", "--local"], ["deploy", "--env=", "--dry-run"]]) {
      expect(reachesCloudflare(args), args.join(" ")).toBe(false);
    }
    for (const args of [
      ["deploy", "--env="],
      ["dev", "--remote"],
      ["dev", "-r"],
      ["dev", "--remote=true"],
      ["dev", "--remote=false"],
      ["dev", "--remote="],
      ["dev", "-r=1"],
      ["d1", "migrations", "apply", "DB", "--remote"],
      ["d1", "migrations", "apply", "DB", "--local", "--remote"],
      ["secret", "put", "X"],
      ["deploy", "--dry-run=false"],
      ["d1", "execute", "DB", "--local=false"],
      ["tail"],
    ]) {
      expect(reachesCloudflare(args), args.join(" ")).toBe(true);
    }
  });

  it("appends the picked config and refuses remote commands without the local config, running nothing", () => {
    const local = path.join(ROOT, "wrangler.jsonc");
    expect(wranglerArgv("main", ["deploy", "--env="], ROOT, only(local))).toEqual({ ok: true, argv: ["deploy", "--env=", "--config", local], config: local });
    const refused = wranglerArgv("main", ["deploy", "--env="], ROOT, only());
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toMatch(/^refused: wrangler\.jsonc is missing, .*nothing was run/);
    const example = path.join(ROOT, "wrangler.example.jsonc");
    expect(wranglerArgv("main", ["dev", "--port", "8787"], ROOT, only())).toEqual({ ok: true, argv: ["dev", "--port", "8787", "--config", example], config: example });
    expect(wranglerArgv("e2e", ["deploy", "--env=", "--dry-run"], ROOT, only()).ok).toBe(true);
    expect(wranglerArgv("fake", ["deploy"], ROOT, only()).ok).toBe(false);
  });

  it("refuses a caller-chosen config, so a script cannot be pointed at another Worker's config", () => {
    const local = path.join(ROOT, "wrangler.jsonc");
    for (const flag of [["-c", "wrangler.e2e.jsonc"], ["--config", "x"], ["--config=x"], ["-c=x"]]) {
      expect(wranglerArgv("main", ["dev", ...flag], ROOT, only(local)).ok, flag.join(" ")).toBe(false);
    }
    expect(wranglerArgv("main", [], ROOT, only(local)).ok).toBe(false);
  });

  it("starts no remote dev from the example: -r, --remote and --remote=<v> all need the local config", () => {
    for (const flag of ["-r", "--remote", "--remote=true", "--remote=false", "-r=1"]) {
      const res = wranglerArgv("main", ["dev", flag], ROOT, only());
      expect(res.ok, flag).toBe(false);
      expect(!res.ok && res.message, flag).toMatch(/^refused: wrangler\.jsonc is missing/);
    }
  });

  it("refuses any non-empty --env: each config is one top-level Worker, so --env could only reach a stale block", () => {
    const local = path.join(ROOT, "wrangler.jsonc");
    for (const kind of Object.keys(CONFIGS) as Array<keyof typeof CONFIGS>) {
      const cfg = path.join(ROOT, CONFIGS[kind].local);
      for (const flag of [["--env", "e2e"], ["--env=e2e"], ["-e", "e2e"], ["-e=e2e"], ["--env", "production"], ["--env"], ["-e"]]) {
        const res = wranglerArgv(kind, ["deploy", "--dry-run", ...flag], ROOT, only(cfg));
        expect(res.ok, `${kind} ${flag.join(" ")}`).toBe(false);
        expect(!res.ok && res.message, flag.join(" ")).toMatch(/^refused: --env/);
      }
    }
    // The empty env pins the top level, as the deploy scripts do.
    for (const flag of [["--env="], ["--env", ""], ["-e="]]) {
      expect(wranglerArgv("main", ["deploy", ...flag], ROOT, only(local)).ok, flag.join(" ")).toBe(true);
    }
  });
});

describe("parseJsonc", () => {
  it("accepts comments and trailing commas, and leaves comment-like text inside strings", () => {
    const text = '// head\n{ "a": [1, 2,], /* b */ "s": "x//y/*z*/", "e": "q\\"//", "n": null, "t": true, }\n';
    expect(parseJsonc(text)).toEqual({ a: [1, 2], s: "x//y/*z*/", e: 'q"//', n: null, t: true });
  });

  it("keeps a __proto__ key as a plain key", () => {
    const value = parseJsonc('{ "__proto__": { "polluted": 1 } }') as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects malformed input with an offset and no content", () => {
    for (const bad of ['{"a":1,,}', '{"a":}', "[1 2]", '{"a":1} x', '{"a":"x\ny"}', "{,}", '{"a": 1', "/* open", '{"k": "secret-value'] as const) {
      expect(() => parseJsonc(bad), bad).toThrow(/^invalid JSONC: .* at offset \d+$/);
      try {
        parseJsonc(bad);
      } catch (e) {
        expect((e as Error).message).not.toContain("secret-value");
      }
    }
  });

  it("records string spans, so a value can be replaced in place", () => {
    const text = '{ "name": "old" /* keep */ }';
    const root = parseJsoncTree(text);
    const name = root.kind === "object" ? root.entries[0]?.value : undefined;
    expect(name?.kind === "string" && text.slice(name.start, name.end)).toBe('"old"');
  });
});

describe("tracked wrangler configs", () => {
  it("are templates: no account id or resource id, placeholder ids only, no PUBLIC_BASE_URL", () => {
    for (const kind of Object.keys(CONFIGS) as Array<keyof typeof CONFIGS>) {
      const text = readFileSync(path.join(REPO, CONFIGS[kind].example), "utf8");
      const config = parseJsonc(text) as Record<string, unknown>;
      expect(config.account_id, kind).toBeUndefined();
      expect(text, kind).not.toMatch(/workers\.dev"/);
      expect((config.vars as Record<string, unknown>).PUBLIC_BASE_URL, kind).toBeUndefined();
      for (const db of (config.d1_databases as Array<{ database_id: string }> | undefined) ?? []) expect(db.database_id).toMatch(/^0{8}-0{4}-0{4}-0{4}-0{10}..$/);
      for (const kv of (config.kv_namespaces as Array<{ id: string }> | undefined) ?? []) expect(kv.id).toMatch(/^0{30}..$/);
    }
  });

  it("keep the fake Google out of production: only the E2E template binds it or runs fake mode", () => {
    const main = parseJsonc(readFileSync(path.join(REPO, CONFIGS.main.example), "utf8")) as Record<string, unknown>;
    expect(main.services).toBeUndefined();
    expect(main.env).toBeUndefined();
    expect(main.vars).toEqual({ GOOGLE_UPSTREAM: "google", GOOGLE_SCOPE_PRESET: "narrow" });
    expect(JSON.stringify(main)).not.toMatch(/FAKE/);
    const e2e = parseJsonc(readFileSync(path.join(REPO, CONFIGS.e2e.example), "utf8")) as Record<string, unknown>;
    expect(e2e.name).toBe("gws-mcp-e2e");
    expect(e2e.services).toEqual([{ binding: "FAKE_GOOGLE", service: "gws-mcp-fake-google" }]);
    expect((e2e.vars as Record<string, unknown>).GOOGLE_UPSTREAM).toBe("fake");
    expect(e2e.env).toBeUndefined();
  });

  it("are the ones vitest and `npm run types` read; the ignore rules cover the operator configs, never the examples", () => {
    expect(readFileSync(path.join(REPO, "vitest.config.ts"), "utf8")).toContain('configPath: "./wrangler.example.jsonc"');
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.types).toBe("wrangler types -c wrangler.example.jsonc");
    // Every other wrangler script goes through the picker; none names a config or an `--env`.
    for (const [name, script] of Object.entries(pkg.scripts)) {
      if (name === "types" || !/\bwrangler\b/.test(script)) continue;
      expect(script, name).toMatch(/^(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false )?tsx scripts\/wrangler\.ts (main|e2e|fake) /);
      expect(script, name).not.toMatch(/ -c |--config|--env e2e/);
    }
    expect(pkg.scripts.deploy).toBe('tsx scripts/wrangler.ts main deploy --env=""');
    expect(pkg.scripts["deploy:e2e"]).toBe('tsx scripts/wrangler.ts e2e deploy --env=""');
    // The .gitignore rules themselves (`--no-index`), whatever the index holds right now; the examples are tracked.
    const ignored = (file: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: REPO });
        return true;
      } catch {
        return false;
      }
    };
    for (const { local, example } of Object.values(CONFIGS)) {
      expect(ignored(local), local).toBe(true);
      expect(ignored(example), example).toBe(false);
      expect(execFileSync("git", ["ls-files", "--", example], { cwd: REPO, encoding: "utf8" }).trim(), example).toBe(example);
      const text = readFileSync(path.join(REPO, example), "utf8");
      expect(text, example).not.toMatch(/"account_id"\s*:\s*"[0-9a-f]/);
      for (const id of text.match(IDS) ?? []) expect(id, example).toMatch(PLACEHOLDER);
    }
  });
});

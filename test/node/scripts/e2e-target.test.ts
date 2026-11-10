import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { E2E_DATABASE, d1ExecuteArgs } from "../../../scripts/e2e/d1-scan";
import { FakeGoogle } from "../../../scripts/e2e/oauth-driver";
import { loadRunSecrets, readDeployedE2E, resolveTarget, targetOrigin } from "../../../scripts/e2e/target";

const LOCAL_FAKE = "http://localhost:8788";
/** The deployed E2E Worker and its fake, as a local wrangler.e2e.jsonc names them (neutral example hosts). */
const E2E_ORIGIN = "https://gws-mcp-e2e.example.workers.dev";
const E2E_FAKE_ORIGIN = "https://gws-mcp-fake-google.example.workers.dev";
const PROD_ORIGIN = "https://gws-mcp.example.workers.dev";

const FAKE_SERVICE = [{ binding: "FAKE_GOOGLE", service: "gws-mcp-fake-google" }];

/**
 * A local wrangler.e2e.jsonc in `dir` (JSONC: comments and a trailing comma): fake mode and the FAKE_GOOGLE binding
 * unless overridden, plus these vars.
 */
function writeE2eConfig(dir: string, vars: Record<string, string>, opts: { name?: string; services?: unknown[] } = {}): void {
  const body = Object.entries({ GOOGLE_UPSTREAM: "fake", ...vars })
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n");
  const services = JSON.stringify(opts.services ?? FAKE_SERVICE);
  writeFileSync(
    path.join(dir, "wrangler.e2e.jsonc"),
    `// local\n{\n  "name": ${JSON.stringify(opts.name ?? "gws-mcp-e2e")},\n  "services": ${services},\n  "vars": {\n${body}\n  },\n}\n`,
  );
}

/** The local production wrangler.jsonc in `dir`. */
function writeMainConfig(dir: string, vars: Record<string, string>, name = "gws-mcp"): void {
  writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({ name, vars: { GOOGLE_UPSTREAM: "google", ...vars } }));
}

const PROD_KEY = "production-token-enc-key-value";
const E2E_KEY = "e2e-token-enc-key-value";
const LOCAL_KEY = "local-dev-token-enc-key-value";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "e2e-target-"));
  writeE2eConfig(root, { GOOGLE_UPSTREAM: "fake", PUBLIC_BASE_URL: E2E_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** The default deployed env file of a target rooted at `root` (a temp-dir fixture standing in for the repo's). */
const deployedEnvFile = () => path.join(root, ".env");

describe("e2e harness target", () => {
  it("targets the deployed E2E Worker's remote D1 and reads E2E_TOKEN_ENC_KEY, never the production key", () => {
    writeFileSync(
      deployedEnvFile(),
      `TOKEN_ENC_KEY=${PROD_KEY}\nE2E_TOKEN_ENC_KEY=${E2E_KEY}\nFAKE_ADMIN_TOKEN=admin-value-0000\nFAKE_LOGIN_SECRET=login-value-0000\nGOOGLE_CLIENT_SECRET=real-google-secret\n`,
    );
    const target = resolveTarget(targetOrigin("--base", `${E2E_ORIGIN}/mcp`), { fake: E2E_FAKE_ORIGIN, root, remoteD1: true, envFiles: [] });
    expect(target).toEqual({ fake: E2E_FAKE_ORIGIN, d1: "remote", envFiles: [deployedEnvFile()], tokenKeyName: "E2E_TOKEN_ENC_KEY" });

    const secrets = loadRunSecrets(target);
    expect(secrets.tokenEncKey).toBe(E2E_KEY);
    expect(secrets.adminToken).toBe("admin-value-0000");
    expect(secrets.loginSecret).toBe("login-value-0000");
    expect(secrets.all).not.toContain(PROD_KEY);
    expect(secrets.all).not.toContain("real-google-secret");
  });

  it("has no token key for the E2E Worker when only the production key is present", () => {
    writeFileSync(deployedEnvFile(), `TOKEN_ENC_KEY=${PROD_KEY}\n`);
    const secrets = loadRunSecrets(resolveTarget(E2E_ORIGIN, { fake: E2E_FAKE_ORIGIN, root, remoteD1: false, envFiles: [] }));
    expect(secrets.tokenEncKey).toBeUndefined();
    expect(secrets.all).toEqual([]);
  });

  it("uses the E2E key name with --env-file too", () => {
    const file = path.join(root, "other-secrets.txt");
    writeFileSync(file, `TOKEN_ENC_KEY=${PROD_KEY}\nE2E_TOKEN_ENC_KEY=${E2E_KEY}\n`);
    const target = resolveTarget(E2E_ORIGIN, { fake: E2E_FAKE_ORIGIN, root, remoteD1: true, envFiles: [file] });
    expect(target.envFiles).toEqual([file]);
    expect(loadRunSecrets(target)).toEqual({ tokenEncKey: E2E_KEY, all: [E2E_KEY] });
  });

  it("targets the local D1 and the local dev files for a loopback base", () => {
    writeFileSync(path.join(root, ".dev.vars"), `TOKEN_ENC_KEY=${LOCAL_KEY}\nE2E_TOKEN_ENC_KEY=${E2E_KEY}\n`);
    for (const base of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const target = resolveTarget(targetOrigin("--base", base), { fake: LOCAL_FAKE, root, remoteD1: false, envFiles: [] });
      expect(target).toEqual({
        fake: LOCAL_FAKE,
        d1: "local",
        envFiles: [path.join(root, ".dev.vars"), path.join(root, "fake-google", ".dev.vars")],
        tokenKeyName: "TOKEN_ENC_KEY",
      });
      expect(loadRunSecrets(target).tokenEncKey).toBe(LOCAL_KEY);
    }
  });

  it("refuses --remote-d1 with a loopback base", () => {
    expect(() => resolveTarget("http://localhost:8787", { fake: LOCAL_FAKE, root, remoteD1: true, envFiles: [] })).toThrow(/--remote-d1/);
  });

  it("refuses the production Worker and any other host before anything is read or sent", () => {
    for (const base of [
      PROD_ORIGIN,
      "https://GWS-MCP.example.workers.dev/mcp",
      "https://user:pw@gws-mcp.example.workers.dev",
      "https://gws-mcp-e2e.example.workers.dev@gws-mcp.example.workers.dev",
      "https://gws-mcp-e2e.example.workers.dev:8443",
      "https://gws-mcp-e2e.example.workers.dev.evil.test",
      "https://example.test",
    ]) {
      expect(() => resolveTarget(targetOrigin("--base", base), { fake: E2E_FAKE_ORIGIN, root, remoteD1: true, envFiles: [] })).toThrow(/nothing was sent/);
    }
    expect(() => targetOrigin("--base", "http://gws-mcp-e2e.example.workers.dev")).toThrow(/must be https/);
  });

  it("runs every D1 query on the E2E database with the E2E config, never the production database or config", () => {
    expect(E2E_DATABASE).toBe("gws-mcp-e2e");
    const local = path.join(root, "wrangler.e2e.jsonc");
    for (const mode of ["local", "remote"] as const) {
      const args = d1ExecuteArgs(mode, "SELECT 1", root);
      expect(args).toEqual(["wrangler", "d1", "execute", "gws-mcp-e2e", `--${mode}`, "--json", "--command", "SELECT 1", "--config", local]);
      expect(args).not.toContain("gws-mcp");
      expect(args).not.toContain(path.join(root, "wrangler.jsonc"));
    }
  });

  it("uses the tracked E2E example only for local D1, and refuses remote D1 without the local E2E config", () => {
    rmSync(path.join(root, "wrangler.e2e.jsonc"));
    expect(d1ExecuteArgs("local", "SELECT 1", root).slice(-2)).toEqual(["--config", path.join(root, "wrangler.e2e.example.jsonc")]);
    expect(() => d1ExecuteArgs("remote", "SELECT 1", root)).toThrow(/refused: wrangler\.e2e\.jsonc is missing.*nothing was run/);
  });

  it("reads the deployed E2E target only from the local wrangler.e2e.jsonc", () => {
    expect(readDeployedE2E(root)).toEqual({ origin: E2E_ORIGIN, fake: E2E_FAKE_ORIGIN });
    // No local config, or one without PUBLIC_BASE_URL: no deployed target at all (the example's hosts never count).
    writeFileSync(
      path.join(root, "wrangler.e2e.example.jsonc"),
      JSON.stringify({ vars: { PUBLIC_BASE_URL: E2E_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN } }),
    );
    rmSync(path.join(root, "wrangler.e2e.jsonc"));
    expect(readDeployedE2E(root)).toBeNull();
    expect(() => resolveTarget(E2E_ORIGIN, { fake: E2E_FAKE_ORIGIN, root, remoteD1: true, envFiles: [] })).toThrow(
      /no deployed E2E Worker.*nothing was sent/,
    );
    writeE2eConfig(root, { FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN });
    expect(readDeployedE2E(root)).toBeNull();
  });

  it("refuses a local E2E config with plain-http, loopback or missing fake origins", () => {
    for (const vars of <Array<Record<string, string>>>[
      { PUBLIC_BASE_URL: "http://gws-mcp-e2e.example.workers.dev", FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN },
      { PUBLIC_BASE_URL: E2E_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: "http://gws-mcp-fake-google.example.workers.dev" },
      { PUBLIC_BASE_URL: "http://localhost:8787", FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN },
      { PUBLIC_BASE_URL: E2E_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: "http://localhost:8788" },
      { PUBLIC_BASE_URL: E2E_ORIGIN },
    ]) {
      writeE2eConfig(root, vars);
      expect(() => readDeployedE2E(root), JSON.stringify(vars)).toThrow(/must be https|non-loopback|FAKE_GOOGLE_PUBLIC_URL/);
    }
  });

  it("refuses an E2E config that is not in fake mode or does not bind the fake, before anything is read or sent", () => {
    const vars = { PUBLIC_BASE_URL: E2E_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    writeFileSync(deployedEnvFile(), `E2E_TOKEN_ENC_KEY=${E2E_KEY}\n`);
    for (const [label, write] of [
      ["upstream google", () => writeE2eConfig(root, { ...vars, GOOGLE_UPSTREAM: "google" })],
      ["upstream unset", () => writeE2eConfig(root, { ...vars, GOOGLE_UPSTREAM: "" })],
      ["no FAKE_GOOGLE binding", () => writeE2eConfig(root, vars, { services: [] })],
      ["FAKE_GOOGLE bound to another Worker", () => writeE2eConfig(root, vars, { services: [{ binding: "FAKE_GOOGLE", service: "gws-mcp" }] })],
    ] as const) {
      write();
      expect(() => readDeployedE2E(root), label).toThrow(/is not a fake-mode E2E config.*nothing was sent/);
      expect(() => resolveTarget(E2E_ORIGIN, { fake: E2E_FAKE_ORIGIN, root, remoteD1: true, envFiles: [] }), label).toThrow(/nothing was sent/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an E2E config that names production: its Worker name or its public URL", () => {
    writeMainConfig(root, { PUBLIC_BASE_URL: PROD_ORIGIN });
    // A distinct E2E config next to production is fine.
    expect(readDeployedE2E(root)).toEqual({ origin: E2E_ORIGIN, fake: E2E_FAKE_ORIGIN });
    for (const [label, write] of [
      ["production's URL", () => writeE2eConfig(root, { PUBLIC_BASE_URL: PROD_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN })],
      ["production's URL, other spelling", () => writeE2eConfig(root, { PUBLIC_BASE_URL: "https://GWS-MCP.example.workers.dev/", FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN })],
      ["production's Worker name", () => writeE2eConfig(root, { PUBLIC_BASE_URL: E2E_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN }, { name: "gws-mcp" })],
    ] as const) {
      write();
      expect(() => readDeployedE2E(root), label).toThrow(/names the production Worker.*nothing was sent/);
    }
    // Production without PUBLIC_BASE_URL (derived from requests): the name check still applies.
    writeMainConfig(root, {});
    writeE2eConfig(root, { PUBLIC_BASE_URL: E2E_ORIGIN, FAKE_GOOGLE_PUBLIC_URL: E2E_FAKE_ORIGIN }, { name: "gws-mcp" });
    expect(() => readDeployedE2E(root)).toThrow(/names the production Worker/);
  });

  it("pins --fake to the target's own fake: production, the E2E base, a lookalike or a loopback fake are refused for the E2E Worker", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const fake of [
      PROD_ORIGIN,
      E2E_ORIGIN,
      "https://gws-mcp-fake-google.example.workers.dev.evil.test",
      "https://gws-mcp-fake-google-x.example.workers.dev",
      LOCAL_FAKE,
    ]) {
      expect(() => resolveTarget(E2E_ORIGIN, { fake: targetOrigin("--fake", fake), root, remoteD1: true, envFiles: [] }), fake).toThrow(
        /--fake must be https:\/\/gws-mcp-fake-google\.example\.workers\.dev .*nothing was sent/,
      );
    }
    expect(resolveTarget(E2E_ORIGIN, { fake: targetOrigin("--fake", `${E2E_FAKE_ORIGIN}/`), root, remoteD1: true, envFiles: [] }).fake).toBe(E2E_FAKE_ORIGIN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a non-loopback fake for a loopback base", () => {
    for (const fake of [E2E_FAKE_ORIGIN, PROD_ORIGIN]) {
      expect(() => resolveTarget("http://localhost:8787", { fake, root, remoteD1: false, envFiles: [] })).toThrow(/loopback fake.*nothing was sent/);
    }
  });

  describe("FakeGoogle.requireGuarded", () => {
    const ADMIN = "admin-secret-value-0000000000000000";
    const LOGIN = "login-secret-value-0000000000000000";

    /** Stubs fetch with a fixed status and records every request's URL, headers and body. */
    function stubFetch(status: number): Array<{ url: string; headers: Headers; body: string }> {
      const seen: Array<{ url: string; headers: Headers; body: string }> = [];
      vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
        seen.push({ url: String(input), headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" });
        return new Response("{}", { status });
      });
      return seen;
    }

    const expectNoSecretSent = (seen: ReadonlyArray<{ url: string; headers: Headers; body: string }>) => {
      for (const q of seen) {
        expect(q.headers.has("x-fake-admin")).toBe(false);
        for (const v of [ADMIN, LOGIN]) {
          expect(q.url).not.toContain(v);
          expect(q.body).not.toContain(v);
          expect([...q.headers.values()].join(" ")).not.toContain(v);
        }
      }
    };

    it("throws for production as --fake (404) after one unauthenticated request, with no secret sent", async () => {
      const seen = stubFetch(404);
      const fake = new FakeGoogle(PROD_ORIGIN, { adminToken: ADMIN, loginSecret: LOGIN });
      await expect(fake.requireGuarded()).rejects.toThrow(/returned 404, not 401; no secret was sent/);
      expect(seen.map((q) => new URL(q.url).pathname)).toEqual(["/__fake/state"]);
      expectNoSecretSent(seen);
    });

    it("throws when the control route is open (200: a fake without an admin token)", async () => {
      const seen = stubFetch(200);
      await expect(new FakeGoogle(E2E_FAKE_ORIGIN, { adminToken: ADMIN, loginSecret: LOGIN }).requireGuarded()).rejects.toThrow(/returned 200/);
      expectNoSecretSent(seen);
    });

    it("passes on 401, still without sending a secret", async () => {
      const seen = stubFetch(401);
      expect(await new FakeGoogle(E2E_FAKE_ORIGIN, { adminToken: ADMIN, loginSecret: LOGIN }).requireGuarded()).toBe(401);
      expect(seen).toHaveLength(1);
      expectNoSecretSent(seen);
    });
  });
});

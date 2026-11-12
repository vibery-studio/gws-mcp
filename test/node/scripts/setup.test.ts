import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GoogleClient, type WranglerResult, ownerEmail, ownerInsertSql, parseClientLines, setup, withResourceIds } from "../../../scripts/setup";
import { parseJsonc } from "../../../scripts/wrangler";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const CLIENT: GoogleClient = { id: "123-abc.apps.googleusercontent.com", secret: "dummy-client-secret-0000" };
const KEY = "generated-token-enc-key-value-000000000000=";
const D1_ID = "11111111-2222-4333-8444-555555555555";
const KV_IDS: Record<string, string> = { "gws-mcp-oauth": "a".repeat(32), "gws-mcp-cache": "c".repeat(32) };
const OWNER = "owner@example.com";

interface Call {
  args: string[];
  stdin?: string;
}

/** A stand-in Cloudflare account behind `wrangler`: D1 and KV lists, a Worker and its secret names. */
function account(
  opts: { d1?: Array<{ name: string; uuid: string }>; kv?: Array<{ title: string; id: string }>; secrets?: string[]; worker?: boolean; fail?: string; rules?: string[] } = {},
) {
  const state = {
    d1: [...(opts.d1 ?? [])],
    kv: [...(opts.kv ?? [])],
    secrets: new Set(opts.secrets ?? []),
    worker: opts.worker ?? false,
    deployedWithSecrets: [] as string[][],
    /** The remote access list: patterns of its rules. */
    rules: [...(opts.rules ?? [])],
  };
  const calls: Call[] = [];
  const ok = (stdout = ""): WranglerResult => ({ code: 0, stdout, stderr: "" });
  const wrangler = async (args: readonly string[], stdin?: string): Promise<WranglerResult> => {
    calls.push({ args: [...args], ...(stdin !== undefined ? { stdin } : {}) });
    const cmd = args.slice(0, 3).join(" ");
    if (opts.fail && args.join(" ").startsWith(opts.fail)) return { code: 1, stdout: "", stderr: `boom ${stdin ?? ""}\n` };
    if (cmd === "d1 list --json") return ok(JSON.stringify(state.d1));
    if (cmd.startsWith("d1 create")) {
      state.d1.push({ name: args[2] as string, uuid: D1_ID });
      return ok("Successfully created DB");
    }
    if (cmd === "kv namespace list") return ok(JSON.stringify(state.kv));
    if (cmd === "kv namespace create") {
      const title = args[3] as string;
      state.kv.push({ title, id: KV_IDS[title] ?? "f".repeat(32) });
      return ok("created");
    }
    if (cmd.startsWith("d1 migrations apply")) return ok("migrations applied");
    if (cmd === "d1 execute DB") {
      const sql = args[args.indexOf("--command") + 1] ?? "";
      if (sql === "SELECT COUNT(*) AS n FROM access_rules") return ok(JSON.stringify([{ results: [{ n: state.rules.length }], success: true }]));
      const m = /^INSERT INTO access_rules \(pattern, role, note, created_by, created_at\) SELECT '([^']+)', 'admin'.*WHERE NOT EXISTS \(SELECT 1 FROM access_rules\);/.exec(sql);
      if (m?.[1] && sql.includes("INSERT INTO access_audit")) {
        if (state.rules.length === 0) state.rules.push(m[1]);
        return ok("executed");
      }
    }
    if (cmd === "secret list --name") {
      if (!state.worker) return { code: 1, stdout: "", stderr: `✘ [ERROR] Worker "${args[3]}" not found.\n\nIf this is a new Worker, run \`wrangler deploy\` first to create it.\n` };
      return ok(JSON.stringify([...state.secrets].map((name) => ({ name, type: "secret_text" }))));
    }
    if (cmd.startsWith("secret put")) {
      state.worker = true;
      state.secrets.add(args[2] as string);
      return ok("✨ Success! Uploaded secret");
    }
    if (args[0] === "deploy") {
      state.deployedWithSecrets.push([...state.secrets].sort());
      state.worker = true;
      return ok("Uploaded gws-mcp\nDeployed gws-mcp triggers\n  https://gws-mcp.example-sub.workers.dev\n");
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  return { state, calls, wrangler };
}

let root: string;
let logs: string[];
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "gws-mcp-setup-"));
  copyFileSync(path.join(REPO, "wrangler.example.jsonc"), path.join(root, "wrangler.example.jsonc"));
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const configPath = () => path.join(root, "wrangler.jsonc");
interface WrittenConfig {
  name: string;
  d1_databases: Array<{ binding: string; database_name: string; database_id: string; migrations_dir: string }>;
  kv_namespaces: Array<{ binding: string; id: string }>;
}
const readConfig = () => parseJsonc(readFileSync(configPath(), "utf8")) as WrittenConfig;

function run(acct: ReturnType<typeof account>, prefix = "gws-mcp", client: GoogleClient | null = CLIENT, owner: string | null = OWNER) {
  let asked = 0;
  let askedOwner = 0;
  return {
    result: setup(prefix, {
      root,
      wrangler: acct.wrangler,
      readGoogleClient: async () => {
        asked++;
        return client;
      },
      readOwnerEmail: async () => {
        askedOwner++;
        return owner;
      },
      generateKey: () => KEY,
      log: (line) => logs.push(line),
    }),
    asked: () => asked,
    askedOwner: () => askedOwner,
  };
}

/** No secret value in any argv or log line; values only ever on stdin. */
function expectNoValuesOutsideStdin(calls: Call[]): void {
  for (const value of [KEY, CLIENT.id, CLIENT.secret]) {
    for (const c of calls) expect(c.args.join(" ")).not.toContain(value);
    for (const line of logs) expect(line).not.toContain(value);
  }
}

describe("setup", () => {
  it("stands up a fresh deployment: config, resources, migrations, secrets over stdin, then deploy and the redirect URI", async () => {
    const acct = account();
    const { result, asked } = run(acct);
    expect(await result).toEqual({ exitCode: 0 });

    // Resources created by exact name, never letting wrangler edit a config; nothing for the fake or the E2E Worker.
    const creates = acct.calls.filter((c) => c.args[1] === "create" || c.args[2] === "create").map((c) => c.args.slice(0, 5));
    expect(creates).toEqual([
      ["d1", "create", "gws-mcp", "--update-config=false", "--config"],
      ["kv", "namespace", "create", "gws-mcp-oauth", "--update-config=false"],
      ["kv", "namespace", "create", "gws-mcp-cache", "--update-config=false"],
    ]);
    expect(acct.calls.map((c) => c.args.filter((a) => a !== configPath()).join(" ")).join("\n")).not.toMatch(/fake|e2e/);
    // Every command carries the local config.
    for (const c of acct.calls) expect(c.args.slice(-2)).toEqual(["--config", configPath()]);

    // The ids are written into the local config created from the example; its comments stay.
    const config = readConfig();
    expect(config.name).toBe("gws-mcp");
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "gws-mcp", database_id: D1_ID, migrations_dir: "migrations" }]);
    expect(config.kv_namespaces).toEqual([
      { binding: "OAUTH_KV", id: KV_IDS["gws-mcp-oauth"] },
      { binding: "CACHE_KV", id: KV_IDS["gws-mcp-cache"] },
    ]);
    expect(readFileSync(configPath(), "utf8")).toContain("// Secrets stay reachable only through `env`");

    // Order: migrations, secrets (the deploy needs them), then the top-level deploy.
    const order = acct.calls.map((c) => c.args.slice(0, 3).join(" "));
    const at = (prefix: string) => order.findIndex((o) => o.startsWith(prefix));
    expect(at("d1 migrations apply")).toBeLessThan(at("secret list"));
    expect(at("secret put")).toBeLessThan(at("deploy"));
    expect(acct.calls.find((c) => c.args[0] === "d1" && c.args[1] === "migrations")?.args.slice(0, 5)).toEqual(["d1", "migrations", "apply", "DB", "--remote"]);
    expect(acct.calls.filter((c) => c.args[0] === "deploy").map((c) => c.args.slice(0, 2))).toEqual([["deploy", "--env="]]);
    expect(acct.state.deployedWithSecrets).toEqual([["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENC_KEY"]]);

    // Secrets travel only on stdin.
    const puts = acct.calls.filter((c) => c.args[1] === "put").map((c) => [c.args[2], c.args[4], c.stdin]);
    expect(puts).toEqual([
      ["TOKEN_ENC_KEY", "gws-mcp", KEY],
      ["GOOGLE_CLIENT_ID", "gws-mcp", CLIENT.id],
      ["GOOGLE_CLIENT_SECRET", "gws-mcp", CLIENT.secret],
    ]);
    expectNoValuesOutsideStdin(acct.calls);
    expect(asked()).toBe(1);
    expect(logs).toContain("redirect URI: https://gws-mcp.example-sub.workers.dev/google/callback");
  });

  it("is idempotent: a second run creates nothing, replaces no secret, asks for nothing, and leaves the config byte for byte", async () => {
    const acct = account();
    expect(await run(acct).result).toEqual({ exitCode: 0 });
    const configBefore = readFileSync(configPath(), "utf8");
    acct.calls.length = 0;
    logs = [];

    const again = run(acct);
    expect(await again.result).toEqual({ exitCode: 0 });
    expect(acct.calls.filter((c) => c.args.includes("create") || c.args[1] === "put")).toEqual([]);
    expect(again.asked()).toBe(0);
    expect(again.askedOwner()).toBe(0);
    expect(acct.state.rules).toEqual([OWNER]);
    expect(readFileSync(configPath(), "utf8")).toBe(configBefore);
    expect(logs).toEqual(
      expect.arrayContaining([
        "d1 gws-mcp: exists",
        "kv gws-mcp-oauth: exists",
        "config wrangler.jsonc: resource ids unchanged",
        "secret TOKEN_ENC_KEY: present, kept (every stored Google token depends on it)",
        "secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: present, kept",
      ]),
    );
  });

  it("reuses existing resources and never replaces a deployed TOKEN_ENC_KEY", async () => {
    const acct = account({
      d1: [{ name: "gws-mcp-e2e", uuid: "99999999-2222-4333-8444-555555555555" }, { name: "gws-mcp", uuid: D1_ID }],
      kv: [
        { title: "gws-mcp-e2e-oauth", id: "e".repeat(32) },
        { title: "gws-mcp-oauth", id: KV_IDS["gws-mcp-oauth"] as string },
        { title: "gws-mcp-cache", id: KV_IDS["gws-mcp-cache"] as string },
      ],
      secrets: ["TOKEN_ENC_KEY"],
      worker: true,
    });
    expect(await run(acct).result).toEqual({ exitCode: 0 });
    expect(acct.calls.some((c) => c.args.includes("create"))).toBe(false);
    expect(acct.calls.filter((c) => c.args[1] === "put").map((c) => c.args[2])).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(readConfig().d1_databases[0]?.database_id).toBe(D1_ID);
    expect(readConfig().kv_namespaces.map((k) => k.id)).toEqual([KV_IDS["gws-mcp-oauth"], KV_IDS["gws-mcp-cache"]]);
  });

  it("names every resource and the Worker after --prefix", async () => {
    const acct = account();
    expect(await run(acct, "team-gws").result).toEqual({ exitCode: 0 });
    expect(readConfig().name).toBe("team-gws");
    expect(readConfig().d1_databases[0]?.database_name).toBe("team-gws");
    expect(acct.calls.filter((c) => c.args.includes("create")).map((c) => c.args[c.args.indexOf("create") + 1])).toEqual([
      "team-gws",
      "team-gws-oauth",
      "team-gws-cache",
    ]);
    for (const c of acct.calls.filter((c) => c.args[0] === "secret")) expect(c.args[c.args.indexOf("--name") + 1]).toBe("team-gws");
  });

  it("refuses an existing config for another Worker or a fake-mode config, changing nothing", async () => {
    for (const config of [
      { name: "other", vars: { GOOGLE_UPSTREAM: "google" } },
      { name: "gws-mcp", vars: { GOOGLE_UPSTREAM: "fake" } },
      { name: "gws-mcp", vars: { GOOGLE_UPSTREAM: "google" }, services: [{ binding: "FAKE_GOOGLE", service: "gws-mcp-fake-google" }] },
    ]) {
      const text = JSON.stringify(config);
      writeFileSync(configPath(), text);
      const acct = account();
      expect(await run(acct).result).toEqual({ exitCode: 2 });
      expect(acct.calls).toEqual([]);
      expect(readFileSync(configPath(), "utf8")).toBe(text);
      expect(logs.at(-1)).toMatch(/^REFUSED: /);
    }
  });

  describe("never repoints a live config", () => {
    const OTHER_DB = "99999999-8888-4777-8666-555555555555";
    /** An existing real-Google config for gws-mcp whose bindings already hold these (real) ids. */
    const liveConfig = (ids: { databaseName: string; databaseId: string; oauthKvId: string; cacheKvId: string }) => {
      const example = readFileSync(path.join(REPO, "wrangler.example.jsonc"), "utf8");
      writeFileSync(configPath(), withResourceIds(example, ids));
      return readFileSync(configPath(), "utf8");
    };
    /** Nothing created, migrated, set or deployed; the config byte for byte; a refusal naming the binding. */
    const expectUntouched = (acct: ReturnType<typeof account>, before: string, binding: string) => {
      expect(acct.calls.filter((c) => c.args.includes("create") || c.args[0] === "secret" || c.args[0] === "deploy" || c.args[1] === "migrations")).toEqual([]);
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(logs.at(-1)).toMatch(new RegExp(`^REFUSED: wrangler\\.jsonc already points ${binding} at `));
      expect(logs.at(-1)).toMatch(/nothing was changed$/);
    };

    it("refuses KV ids whose namespaces have other titles (the stores would be replaced by new, empty ones)", async () => {
      const before = liveConfig({ databaseName: "gws-mcp", databaseId: D1_ID, oauthKvId: "a".repeat(32), cacheKvId: "b".repeat(32) });
      const acct = account({
        d1: [{ name: "gws-mcp", uuid: D1_ID }],
        kv: [
          { title: "my-oauth-kv", id: "a".repeat(32) },
          { title: "my-cache-kv", id: "b".repeat(32) },
        ],
        secrets: ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        worker: true,
      });
      expect(await run(acct).result).toEqual({ exitCode: 2 });
      expectUntouched(acct, before, "OAUTH_KV");
    });

    it("refuses a D1 id whose database has another name", async () => {
      const before = liveConfig({ databaseName: "my-db", databaseId: OTHER_DB, oauthKvId: KV_IDS["gws-mcp-oauth"] as string, cacheKvId: KV_IDS["gws-mcp-cache"] as string });
      const acct = account({
        d1: [{ name: "my-db", uuid: OTHER_DB }],
        kv: [
          { title: "gws-mcp-oauth", id: KV_IDS["gws-mcp-oauth"] as string },
          { title: "gws-mcp-cache", id: KV_IDS["gws-mcp-cache"] as string },
        ],
      });
      expect(await run(acct).result).toEqual({ exitCode: 2 });
      expectUntouched(acct, before, "DB");
    });

    it("refuses when the resource found by name has another id than the config holds", async () => {
      const before = liveConfig({ databaseName: "gws-mcp", databaseId: D1_ID, oauthKvId: KV_IDS["gws-mcp-oauth"] as string, cacheKvId: "b".repeat(32) });
      const acct = account({
        d1: [{ name: "gws-mcp", uuid: D1_ID }],
        kv: [
          { title: "gws-mcp-oauth", id: KV_IDS["gws-mcp-oauth"] as string },
          { title: "gws-mcp-cache", id: KV_IDS["gws-mcp-cache"] as string },
        ],
      });
      expect(await run(acct).result).toEqual({ exitCode: 2 });
      expectUntouched(acct, before, "CACHE_KV");
    });

    it("refuses an existing id when no resource of that name exists at all", async () => {
      const before = liveConfig({ databaseName: "gws-mcp", databaseId: D1_ID, oauthKvId: KV_IDS["gws-mcp-oauth"] as string, cacheKvId: KV_IDS["gws-mcp-cache"] as string });
      const acct = account({
        kv: [
          { title: "gws-mcp-oauth", id: KV_IDS["gws-mcp-oauth"] as string },
          { title: "gws-mcp-cache", id: KV_IDS["gws-mcp-cache"] as string },
        ],
      });
      expect(await run(acct).result).toEqual({ exitCode: 2 });
      expectUntouched(acct, before, "DB");
    });

    it("fills only placeholder bindings, and proceeds when every real id matches its resource", async () => {
      const example = readFileSync(path.join(REPO, "wrangler.example.jsonc"), "utf8");
      // DB already real and matching; the KV ids are still the example's placeholders.
      writeFileSync(configPath(), example.replace('"00000000-0000-0000-0000-000000000000"', JSON.stringify(D1_ID)));
      const acct = account({ d1: [{ name: "gws-mcp", uuid: D1_ID }] });
      expect(await run(acct).result).toEqual({ exitCode: 0 });
      expect(acct.calls.filter((c) => c.args.includes("create")).map((c) => c.args[c.args.indexOf("create") + 1])).toEqual(["gws-mcp-oauth", "gws-mcp-cache"]);
      expect(readConfig().d1_databases[0]?.database_id).toBe(D1_ID);
    });
  });

  it("rejects a malformed prefix before anything runs", async () => {
    for (const prefix of ["", "Gws", "-gws", "gws-", "gws mcp", "gws/../x", "a".repeat(51)]) {
      const acct = account();
      expect(await run(acct, prefix).result, prefix).toEqual({ exitCode: 64 });
      expect(acct.calls).toEqual([]);
      expect(existsSync(configPath())).toBe(false);
    }
  });

  it("stops before deploying when no Google client is given, and when it is malformed, setting neither", async () => {
    for (const client of [null, { id: "not-a-client-id", secret: CLIENT.secret }, { id: CLIENT.id, secret: "has space" }]) {
      const acct = account();
      expect(await run(acct, "gws-mcp", client).result).toEqual({ exitCode: 2 });
      expect(acct.calls.filter((c) => c.args[1] === "put").map((c) => c.args[2])).toEqual(["TOKEN_ENC_KEY"]);
      expect(acct.calls.some((c) => c.args[0] === "deploy")).toBe(false);
      expect(logs.at(-1)).toMatch(/^BLOCKED: /);
      for (const line of logs) expect(line).not.toContain("has space");
      rmSync(configPath());
      logs = [];
    }
  });

  it("stops without setting any secret when the secret list fails for another reason than a missing Worker", async () => {
    const acct = account({ worker: true, fail: "secret list" });
    expect(await run(acct).result).toEqual({ exitCode: 1 });
    expect(acct.calls.some((c) => c.args[1] === "put" || c.args[0] === "deploy")).toBe(false);
  });

  it("stops at the first failing step and scrubs secret values from wrangler's error output", async () => {
    const acct = account({ fail: "secret put GOOGLE_CLIENT_SECRET" });
    expect(await run(acct).result).toEqual({ exitCode: 1 });
    expect(acct.calls.some((c) => c.args[0] === "deploy")).toBe(false);
    expect(logs).toContain("FAILED: could not set GOOGLE_CLIENT_SECRET (exit 1)");
    expect(logs).toContain("  boom [REDACTED]");
    expectNoValuesOutsideStdin(acct.calls);

    const migrate = account({ fail: "d1 migrations apply" });
    logs = [];
    rmSync(configPath());
    expect(await run(migrate).result).toEqual({ exitCode: 1 });
    expect(migrate.calls.some((c) => c.args[0] === "secret" || c.args[0] === "deploy")).toBe(false);
  });

  it("prints the configured PUBLIC_BASE_URL's callback when the config sets one", async () => {
    const acct = account();
    expect(await run(acct).result).toEqual({ exitCode: 0 });
    const text = readFileSync(configPath(), "utf8").replace('"GOOGLE_SCOPE_PRESET": "narrow"', '"GOOGLE_SCOPE_PRESET": "narrow", "PUBLIC_BASE_URL": "https://gws.example.com"');
    writeFileSync(configPath(), text);
    logs = [];
    expect(await run(acct).result).toEqual({ exitCode: 0 });
    expect(logs).toContain("redirect URI: https://gws.example.com/google/callback");
  });
});

describe("the access list's first admin", () => {
  const order = (acct: ReturnType<typeof account>) => acct.calls.map((c) => c.args.slice(0, 3).join(" "));

  it("asks for the owner only while the list is empty, and adds them after the migrations and before the deploy", async () => {
    const acct = account();
    const first = run(acct, "gws-mcp", CLIENT, " Owner@Example.com ");
    expect(await first.result).toEqual({ exitCode: 0 });
    expect(first.askedOwner()).toBe(1);
    expect(acct.state.rules).toEqual([OWNER]);
    const o = order(acct);
    const migrate = o.indexOf("d1 migrations apply");
    const insert = acct.calls.findIndex((c) => (c.args[c.args.indexOf("--command") + 1] ?? "").startsWith("INSERT INTO access_rules"));
    const deploy = o.indexOf("deploy --env= --config");
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(migrate).toBeLessThan(insert);
    expect(insert).toBeLessThan(deploy);
    expect(acct.calls[insert]?.args.slice(0, 4)).toEqual(["d1", "execute", "DB", "--remote"]);
    expect(logs).toContain("access list: owner added as admin");
    expect(logs.some((l) => l.includes(OWNER))).toBe(false);
  });

  it("keeps a list that already has rules, asking nothing", async () => {
    const acct = account({ rules: ["someone@example.com"] });
    const r = run(acct);
    expect(await r.result).toEqual({ exitCode: 0 });
    expect(r.askedOwner()).toBe(0);
    expect(acct.state.rules).toEqual(["someone@example.com"]);
    expect(logs).toContain("access list: 1 rule present, kept");
  });

  it("stops before setting secrets or deploying when no owner, or a malformed or hostile one, is given", async () => {
    for (const owner of [null, "", "not-an-email", "x'); DELETE FROM access_rules; --@example.com", 'a"b@example.com', "a\\b@example.com", "a b@example.com", "a@example.com; DROP TABLE users"]) {
      const acct = account();
      expect(await run(acct, "gws-mcp", CLIENT, owner).result, String(owner)).toEqual({ exitCode: 2 });
      expect(acct.calls.some((c) => (c.args[c.args.indexOf("--command") + 1] ?? "").startsWith("INSERT"))).toBe(false);
      expect(acct.calls.some((c) => c.args[0] === "secret" && c.args[1] === "put")).toBe(false);
      expect(acct.calls.some((c) => c.args[0] === "deploy")).toBe(false);
      expect(acct.state.rules).toEqual([]);
      expect(logs.at(-1)).toMatch(/^BLOCKED: /);
      if (owner) for (const line of logs) expect(line).not.toContain(owner);
      rmSync(configPath());
      logs = [];
    }
  });

  it("stops when the list cannot be read", async () => {
    const acct = account({ fail: "d1 execute DB" });
    expect(await run(acct).result).toEqual({ exitCode: 1 });
    expect(acct.calls.some((c) => c.args[0] === "deploy" || c.args[0] === "secret")).toBe(false);
  });
});

describe("ownerEmail and ownerInsertSql", () => {
  it("accepts only a plain address, lower-cased, and refuses quotes, backslashes, semicolons and whitespace", () => {
    expect(ownerEmail("  Ann.B+x@Mail.Example.com ")).toBe("ann.b+x@mail.example.com");
    for (const bad of ["", "ann", "@example.com", "ann@", "ann@example", "a'b@example.com", 'a"b@example.com', "a\\b@example.com", "a;b@example.com", "a b@example.com", "a\tb@example.com", "ann@exa;mple.com", "ann@-x.com", `${"a".repeat(65)}@example.com`, "\u212Aaren@example.com"]) {
      expect(ownerEmail(bad), bad).toBeNull();
    }
  });

  it("adds the owner once against the real schema, with one audit row, and never a second first admin", () => {
    const db = new DatabaseSync(":memory:");
    for (const m of ["0001_init.sql", "0003_access_rules.sql"]) db.exec(readFileSync(path.join(REPO, "migrations", m), "utf8"));
    db.exec(ownerInsertSql("ann@example.com", 1));
    db.exec(ownerInsertSql("ann@example.com", 2));
    db.exec(ownerInsertSql("bob@example.com", 3));
    expect(db.prepare("SELECT pattern, role, created_by FROM access_rules").all()).toEqual([{ pattern: "ann@example.com", role: "admin", created_by: "setup" }]);
    expect(db.prepare("SELECT actor, via, action, pattern_kind, pattern, role FROM access_audit").all()).toEqual([
      { actor: "setup", via: "setup", action: "add", pattern_kind: "email", pattern: "ann@example.com", role: "admin" },
    ]);
    db.close();
  });

  it("builds a conditional insert with its audit row, and refuses an unchecked value", () => {
    const sql = ownerInsertSql("ann@example.com", 1700000000000);
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM access_rules)");
    expect(sql).toContain("INSERT INTO access_audit");
    expect(() => ownerInsertSql("x'); DROP TABLE users; --@example.com", 1)).toThrow();
    expect(() => ownerInsertSql("Ann@example.com", 1)).toThrow();
  });
});

describe("parseClientLines", () => {
  it("takes the first two non-empty trimmed lines", () => {
    expect(parseClientLines(`\n  ${CLIENT.id}  \r\n\n${CLIENT.secret}\nextra\n`)).toEqual(CLIENT);
    expect(parseClientLines(`${CLIENT.id}\n`)).toBeNull();
    expect(parseClientLines("")).toBeNull();
  });
});

describe("withResourceIds", () => {
  const ids = { databaseName: "p", databaseId: D1_ID, oauthKvId: "a".repeat(32), cacheKvId: "c".repeat(32) };

  it("fills the example's placeholders in place, keeping everything else byte for byte", () => {
    const example = readFileSync(path.join(REPO, "wrangler.example.jsonc"), "utf8");
    const out = withResourceIds(example, ids);
    const strip = (t: string) => t.replace(/"(database_name|database_id|id)": "[^"]*"/g, '"$1": ""');
    expect(strip(out)).toBe(strip(example));
    expect(withResourceIds(out, ids)).toBe(out);
  });

  it("throws when a binding is missing, rather than writing a partial config", () => {
    expect(() => withResourceIds('{ "d1_databases": [], "kv_namespaces": [] }', ids)).toThrow(/has no string d1_databases DB database_name/);
  });
});

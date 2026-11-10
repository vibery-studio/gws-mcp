import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ExecLike, RESET_SQL, resetData } from "../../../scripts/reset-data";

const IDS = { OAUTH_KV: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", CACHE_KV: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
const SESSION_KEY = "session:very-secret-session-id-0000";
const CONFIG_PATH = "/repo/wrangler.jsonc";
const MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "..", "migrations");

/** Every table the migrations leave, each with the tables it references, read from the migration SQL itself. */
function migratedTables(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
    for (const stmt of sql.split(";")) {
      const created = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(stmt)?.[1];
      if (created) tables.set(created, new Set([...stmt.matchAll(/\bREFERENCES\s+(\w+)/gi)].map((m) => m[1] ?? "")));
      const dropped = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i.exec(stmt)?.[1];
      if (dropped) tables.delete(dropped);
    }
  }
  return tables;
}

interface Call {
  args: string[];
  file?: { keys: unknown; mode: number };
}

function stubExec(opts: { titles?: Record<string, string>; keys?: Record<string, string[]>; failOn?: string } = {}): { exec: ExecLike; calls: Call[] } {
  const titles = opts.titles ?? { [IDS.OAUTH_KV]: "gws-mcp-oauth", [IDS.CACHE_KV]: "gws-mcp-cache" };
  const keys = opts.keys ?? { OAUTH_KV: ["grant:u1:g1", "token:u1:g1:h"], CACHE_KV: [SESSION_KEY] };
  const calls: Call[] = [];
  const exec: ExecLike = async (args) => {
    const call: Call = { args: [...args] };
    calls.push(call);
    const joined = args.join(" ");
    if (opts.failOn && joined.includes(opts.failOn)) return { code: 1, stdout: "", stderr: "failed" };
    if (joined.startsWith("kv namespace list")) {
      return { code: 0, stdout: JSON.stringify(Object.entries(titles).map(([id, title]) => ({ id, title }))), stderr: "" };
    }
    if (joined.startsWith("kv key list")) {
      const id = args[args.indexOf("--namespace-id") + 1] ?? "";
      const binding = Object.entries(IDS).find(([, v]) => v === id)?.[0] ?? "";
      return { code: 0, stdout: JSON.stringify((keys[binding] ?? []).map((name) => ({ name }))), stderr: "" };
    }
    if (joined.startsWith("kv bulk delete")) {
      const file = args[3] ?? "";
      call.file = { keys: JSON.parse(readFileSync(file, "utf8")), mode: statSync(file).mode & 0o777 };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "[]", stderr: "" };
  };
  return { exec, calls };
}

const config = { databaseName: "gws-mcp", kv: IDS, configPath: CONFIG_PATH };

describe("reset-data", () => {
  it("deletes every table the migrations create, each before the tables it references", () => {
    const order = [...RESET_SQL.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1] ?? "");
    const tables = migratedTables();
    expect(tables.has("client_approvals")).toBe(true);
    expect([...order].sort()).toEqual([...tables.keys()].sort());
    for (const [table, parents] of tables) {
      for (const parent of parents) if (parent !== table) expect(order.indexOf(table), `${table} before ${parent}`).toBeLessThan(order.indexOf(parent));
    }
  });

  it("prints the plan and touches nothing without --apply", async () => {
    const lines: string[] = [];
    const { exec, calls } = stubExec();
    const res = await resetData({ apply: false, config, exec, log: (l) => lines.push(l) });
    expect(res.exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    const out = lines.join("\n");
    expect(out).toContain(RESET_SQL);
    expect(out).toContain(`OAUTH_KV ${IDS.OAUTH_KV}`);
    expect(out).toContain(`CACHE_KV ${IDS.CACHE_KV}`);
    expect(out).toMatch(/dry run/);
  });

  it("wipes D1 and both KV namespaces, passing keys only through a private temp file", async () => {
    const lines: string[] = [];
    const { exec, calls } = stubExec();
    const res = await resetData({ apply: true, config, exec, log: (l) => lines.push(l) });
    expect(res.exitCode).toBe(0);

    const d1 = calls.find((c) => c.args[0] === "d1");
    expect(d1?.args).toEqual(["d1", "execute", "gws-mcp", "--remote", "--command", RESET_SQL, "--config", CONFIG_PATH]);
    const lists = calls.filter((c) => c.args.slice(0, 3).join(" ") === "kv key list");
    const deletes = calls.filter((c) => c.args.slice(0, 3).join(" ") === "kv bulk delete");
    // The ids whose titles were checked are the ids acted on, never a binding resolved by some other config.
    for (const group of [lists, deletes]) expect(group.map((c) => c.args[c.args.indexOf("--namespace-id") + 1])).toEqual([IDS.OAUTH_KV, IDS.CACHE_KV]);
    for (const c of calls) {
      expect(c.args).not.toContain("--binding");
      expect(c.args[c.args.indexOf("--config") + 1], c.args.join(" ")).toBe(CONFIG_PATH);
    }
    expect(deletes.map((c) => c.file)).toEqual([
      { keys: ["grant:u1:g1", "token:u1:g1:h"], mode: 0o600 },
      { keys: [SESSION_KEY], mode: 0o600 },
    ]);
    for (const c of deletes) {
      expect(c.args).toEqual(expect.arrayContaining(["--remote", "--force"]));
      expect(existsSync(c.args[3] ?? "")).toBe(false);
    }
    for (const c of calls) expect(c.args.join(" ")).not.toContain(SESSION_KEY);
    expect(lines.join("\n")).not.toContain(SESSION_KEY);
    expect(lines).toContain("kv CACHE_KV: deleted 1 keys");
  });

  it("refuses to touch a namespace whose title is not a gws-mcp resource", async () => {
    const { exec, calls } = stubExec({ titles: { [IDS.OAUTH_KV]: "gws-mcp-oauth", [IDS.CACHE_KV]: "someone-elses-kv" } });
    const lines: string[] = [];
    const res = await resetData({ apply: true, config, exec, log: (l) => lines.push(l) });
    expect(res.exitCode).toBe(1);
    expect(calls.map((c) => c.args.slice(0, 3).join(" "))).toEqual(["kv namespace list"]);
    expect(lines.join("\n")).toMatch(/CACHE_KV/);
  });

  it("refuses a database that is not gws-mcp", async () => {
    const { exec, calls } = stubExec();
    const res = await resetData({ apply: true, config: { ...config, databaseName: "other" }, exec, log: () => {} });
    expect(res.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("stops at the first failing step", async () => {
    const { exec, calls } = stubExec({ failOn: "d1 execute" });
    const res = await resetData({ apply: true, config, exec, log: () => {} });
    expect(res.exitCode).toBe(1);
    expect(calls.some((c) => c.args[0] === "kv" && c.args[1] === "bulk")).toBe(false);
  });
});

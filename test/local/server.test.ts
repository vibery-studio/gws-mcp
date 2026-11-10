import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXECUTE_DESCRIPTION, SEARCH_DESCRIPTION } from "../../src/core/tools";
import { localPorts } from "../../src/local/ports";
import { localRegistry, serveStdio } from "../../src/local/server";
import { connectAtFake, localConfig, openLocal, stubFakeGoogle, tempDir } from "./helpers";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
/** How the server says the CLI is run: distinct from the bare name and from npx. */
const SELF = "node '/opt/gws mcp/cli.js'";

/** A newline-delimited JSON-RPC client over the server's stdio streams; it records every line the server wrote. */
function rpcClient(stdin: PassThrough, stdout: PassThrough) {
  const lines: string[] = [];
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  let buffer = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      const m = JSON.parse(line) as Record<string, unknown>;
      if (typeof m.id === "number") waiting.get(m.id)?.(m);
    }
  });
  let next = 1;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return { lines, request, notify };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

async function startServer() {
  const fake = stubFakeGoogle();
  const t = tempDir();
  const l = await openLocal(t.dir);
  cleanups.push(t.cleanup, () => l.store.close());
  const config = localConfig();
  const { account } = await connectAtFake(fake, config, l.store, "me@fake.test", [DRIVE_FILE]);
  const ports = localPorts({ config, store: l.store, secrets: l.secrets });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = serveStdio({ ports, config, self: SELF, stdin, stdout });
  const rpc = rpcClient(stdin, stdout);
  const init = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  rpc.notify("notifications/initialized");
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await rpc.request("tools/call", { name, arguments: args })).result as { content: Array<{ text: string }>; isError?: boolean };
    const text = r.content[0]?.text ?? "null";
    return { value: JSON.parse(text) as Record<string, unknown>, text, isError: r.isError === true };
  };
  return { rpc, init, call, stdin, done, account, store: l.store };
}

describe("the local stdio MCP server", () => {
  it("lists exactly search and execute, with the remote's descriptions", async () => {
    const s = await startServer();
    expect(s.init.result).toMatchObject({ serverInfo: { name: "gws-mcp" } });
    const { tools } = (await s.rpc.request("tools/list")).result as { tools: Array<{ name: string; description: string }> };
    expect(tools.map((t) => t.name).sort()).toEqual(["execute", "search"]);
    expect(tools.find((t) => t.name === "search")?.description).toBe(SEARCH_DESCRIPTION);
    expect(tools.find((t) => t.name === "execute")?.description).toBe(EXECUTE_DESCRIPTION);
    s.stdin.end();
    await s.done;
  });

  it("runs search and an execute through the local runtime, writing nothing but JSON-RPC to stdout", async () => {
    const s = await startServer();
    const found = await s.call("search", { query: "drive files list" });
    expect(found.isError).toBe(false);
    expect(JSON.stringify(found.value)).toContain("drive.files.list");
    const out = await s.call("execute", { code: "async () => (await sdk.accounts.list()).accounts.map((a) => a.email)" });
    expect(out).toMatchObject({ isError: false, value: { ok: true, result: ["me@fake.test"] } });
    const read = await s.call("execute", { code: "async () => (await sdk.drive.files.list({})).files.length >= 0" });
    expect(read.value).toMatchObject({ ok: true, result: true, calls: [{ fn: "drive.files.list", status: "ok", account: "me@fake.test" }] });
    s.stdin.end();
    await s.done;
    expect(s.rpc.lines.length).toBeGreaterThan(0);
    for (const line of s.rpc.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  });

  it("answers accounts.connect with the terminal command and accounts.grant without a link, and search describes that", async () => {
    const s = await startServer();
    const out = await s.call("execute", { code: 'async () => sdk.accounts.connect({ services: ["sheets", "drive"], account: "me@fake.test" })' });
    expect(out.value).toMatchObject({
      ok: true,
      result: { command: `${SELF} accounts add --services sheets,drive --account me@fake.test`, note: expect.stringContaining("terminal") },
    });
    const denied = await s.call("execute", { code: 'async () => sdk.accounts.connect({ services: ["sheets"], account: "nobody@fake.test" })' });
    expect(denied.value).toMatchObject({ ok: false, error: { code: "GWS_ACCOUNT_DENIED", message: expect.stringContaining("not connected to this gws-mcp") } });
    expect(JSON.stringify(denied.value)).not.toMatch(/\/connections|npx/);
    const fresh = await s.call("execute", { code: 'async () => sdk.accounts.connect({ services: ["sheets"] })' });
    expect(fresh.value).toMatchObject({ ok: true, result: { command: `${SELF} accounts add --services sheets` } });
    const granted = await s.call("execute", { code: 'async () => sdk.accounts.grant({ account: "me@fake.test" })', apply: true });
    expect(granted.value).toMatchObject({ ok: true, result: { applied: false, status: "already_granted", email: "me@fake.test" } });
    const notConnected = await s.call("execute", { code: 'async () => sdk.accounts.grant({ account: "other@fake.test" })', apply: true });
    expect(notConnected.value).toMatchObject({ ok: false, error: { code: "GWS_ACCOUNT_DENIED", message: expect.stringContaining(`${SELF} accounts add`) } });
    expect(JSON.stringify(notConnected.value)).not.toContain("/connections");
    const detail = await s.call("search", { query: "", fn: "accounts.connect" });
    expect(detail.value).toMatchObject({ name: "accounts.connect", tsDecl: expect.stringContaining("command: string") });
    s.stdin.end();
    await s.done;
  });

  it("returns a structured tool error for invalid input, never a thrown one", async () => {
    const s = await startServer();
    const r = (await s.rpc.request("tools/call", { name: "execute", arguments: { code: "" } })) as { result?: { isError?: boolean }; error?: unknown };
    expect(r.result?.isError === true || r.error !== undefined).toBe(true);
    s.stdin.end();
    await s.done;
  });
});

describe("local error text", () => {
  it("points at the local commands, never at /connections, for an unknown or disconnected account", async () => {
    const s = await startServer();
    const unknown = await s.call("execute", { code: 'async () => sdk.drive.files.list({ account: "nobody@fake.test" })' });
    expect(unknown.value).toMatchObject({ ok: false, error: { code: "GWS_ACCOUNT_DENIED", message: expect.stringContaining(`${SELF} accounts add`) } });
    expect(unknown.text).not.toContain("/connections");
    await s.store.accounts.wipeToken(s.account.userId, s.account.id);
    const gone = await s.call("execute", { code: "async () => sdk.drive.files.list({})" });
    expect(gone.value).toMatchObject({
      ok: false,
      error: { code: "GWS_RECONNECT_REQUIRED", message: expect.stringContaining(`${SELF} accounts add --account me@fake.test`) },
    });
    expect(gone.text).not.toContain("/connections");
    s.stdin.end();
    await s.done;
  });
});

describe("the local accounts.connect command", () => {
  it("shell-quotes the account's email, which may hold a quote", async () => {
    const connect = localRegistry(SELF).get("accounts.connect");
    const ctx = { accounts: { get: async () => ({ email: "o'neil@example.com" }) } } as unknown as Parameters<NonNullable<NonNullable<typeof connect>["run"]>>[1];
    const out = await connect?.run?.({ services: ["gmail"], account: "o'neil@example.com" }, ctx);
    expect(out).toMatchObject({ command: `${SELF} accounts add --services gmail --account 'o'\\''neil@example.com'` });
  });
});

describe("the local registry", () => {
  it("is the SDK registry with only accounts.connect and accounts.grant replaced", async () => {
    const { getRegistry } = await import("../../src/core/registry");
    const remote = getRegistry();
    const local = localRegistry(SELF);
    expect([...local.keys()].sort()).toEqual([...remote.keys()].sort());
    const changed = [...local.keys()].filter((k) => local.get(k) !== remote.get(k));
    expect(changed.sort()).toEqual(["accounts.connect", "accounts.grant"]);
  });
});
